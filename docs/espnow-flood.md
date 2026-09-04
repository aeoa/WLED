# ESP-NOW command flood

This document describes the WLED ESP-NOW command and clock protocol implemented in
`wled00/espnow_flood.cpp`. It is an application-specific protocol and is separate from WLED's
existing UDP synchronization.

## Purpose and roles

The phone or watch talks over Wi-Fi to one WLED controller, called the **gateway**. The gateway
turns supported JSON state changes into ESP-NOW broadcasts. Every controller validates and relays
each new frame, so the destination can be multiple radio hops away.

The gateway and the **clock root** are different roles. The gateway is whichever controller the
app can currently reach. The clock root is elected by the mesh and can be another controller.
Changing gateways does not by itself change the root.

ESP-NOW flooding is active when both normal WLED ESP-NOW support and ESP-NOW sync are enabled.
All participants must be on the same 2.4 GHz Wi-Fi channel.

## Wire protocol

The current wire version is 5. Frames are packed, little-endian structures and must fit within the
250-byte ESP-NOW payload limit. A receiver silently consumes but rejects a `WF` frame with an
unknown version or invalid length, identity, destination, time, or payload value.

Every frame has a common header containing:

- the `WF` magic, wire version, and packet type;
- the originating MAC, random boot session, and sequence number;
- shared monotonic send time and effect epoch;
- optional Toki wall time;
- elected-root MAC, boot session, and wall-clock stratum;
- destination kind, node MAC or group mask, and remaining hop count; and
- the typed payload length and payload.

The origin/session/sequence tuple identifies one flood. A reboot creates a new random session, so
sequence numbers from different boots are never compared as one stream.

| Type | Name | Purpose |
|---|---|---|
| 1 | Command | Preset, power, brightness, or per-node output trim |
| 2 | Time | Shared monotonic clock, effect epoch, and optional Toki wall time |
| 3 | Announcement | Node identity, name, groups, visible state, and trim |
| 4 | Command acknowledgement | End-to-end receipt for an individually addressed command |
| 5 | State request | A newcomer solicits retained fleet state for its boot session |
| 6 | State replay | Individually addressed retained preset, power, and brightness fields |
| 7 | State acknowledgement | Stops redundant replay transmissions after receipt |

## Flooding and reliability

Destination filtering controls application, not forwarding. A non-destination node still relays a
valid unique frame because it may be the only bridge to the destination. The initial hop budget is
32.

Deduplication uses the origin/session/sequence tuple. Commands, acknowledgements, requests, and
state replays are transmitted three times. Time frames are transmitted twice and announcements
once. Relays add 7-21 ms of jitter; retries are normally separated by at least 24 ms. Only one due
frame is submitted per WLED main-loop iteration, and commands have priority over background time
and discovery traffic.

Fleet and group commands are deliberately best effort. HTTP success means the gateway accepted
the command for flooding; the mesh does not create an acknowledgement storm or wait for offline
nodes. Individually addressed commands include a request ID and produce a flooded end-to-end
acknowledgement. The app polls gateway mesh information for that receipt for up to about three
seconds.

If the gateway cannot enqueue a requested command during a radio transition, `/json/state`
returns HTTP 503 with WLED error 15. The app retries only this explicit admission failure. Other
transport errors are ambiguous because the command may already have entered the mesh.

## Command ordering

Commands can contain any combination of these independent semantic fields:

- preset;
- power;
- brightness; and
- output trim.

Ordering is tracked per origin and boot session, independently for each field. A newer brightness
therefore supersedes an older brightness, but it does not discard an intervening preset or power
change. For example, `brightness -> preset -> power` remains three ordered operations; the first
and third are not merged into a synthetic command.

Preset loading is asynchronous in WLED. Later commands wait behind the preset completion barrier
and are then applied in arrival order. A later queued command can replace an older queued command
only when it contains every semantic field of the older one.

All destinations currently forward through the same mesh:

- fleet: every node applies the command;
- node: only the matching station MAC applies it; and
- group: nodes whose receive-group mask intersects the destination mask apply it.

Group addressing remains in the protocol, but the remote-app UI intentionally hides group
management. Per-node output trim is 1-400 percent and is not overwritten by fleet brightness.
Automatic current limiting is applied after the trim.

## Clocks and synchronized playlists

The protocol synchronizes two related clocks:

1. A wrap-safe monotonic network clock (`millis()` plus a disciplined offset) aligns command
   effect epochs and ordinary effects.
2. Toki wall time supports WLED's clock-synchronized playlists.

The root sends a time frame every five seconds. Small errors outside a 1 ms deadband are corrected
by slewing 1 ms per received beacon. A root change, an uninitialized clock, or an error greater
than 50 ms steps the clock immediately. Relay queue time and a 1 ms link estimate are included in
the correction. Effects use the transmitted effect epoch, so a command that arrives later at one
node still starts at the same phase. Clock-synchronized playlists continue to use Toki directly.

A direct wall-clock source has stratum 0. Time learned through the mesh records its hop distance
and can be propagated from local clocks if the original source later disappears. The election
prefers the lowest stratum and then the lowest root MAC. After 15 seconds without a superior root,
each partition elects its best local candidate. Completely isolated nodes therefore root their
own partitions. When partitions rejoin, flooded time frames make them converge on the preferred
root. If the current root MAC announces a new boot session, followers invalidate its old session
immediately instead of waiting for its old lease to expire.

The remote app can POST second and millisecond wall time with `espt: true`. This makes the reachable
gateway immediately eligible as a direct-time root. NTP remains preferable when it is already
close, and any directly synchronized node can win the election; operation does not depend on the
gateway being the permanent root.

## Retained fleet state and reboot recovery

Each controller retains the newest fleet/group preset, power, and brightness fields in RAM. Values
carry a Lamport revision plus deterministic origin, session, and sequence tie-breakers. Individual
commands and output trim are intentionally private and are not retained as fleet state.

A new boot session solicits retained state before its first announcement. It requests roughly once
per second for the first 15 attempts and then once every five seconds, with additional jitter. Any
node with retained state can respond. Responses are individually addressed and jittered; nodes
suppress their response only after overhearing a replay that covers everything they know. This
allows partial retained knowledge from different partitions to merge field by field.

Retained state is not persisted to flash. If all nodes reboot, fleet state is lost by design. If a
request or response is lost, solicitation and redundant replay continue without requiring a
gateway or clock-root special case.

## Wi-Fi and fallback-AP behavior

When infrastructure Wi-Fi is connected, ESP-NOW follows the router's current channel, so the
router may choose that channel automatically as long as every controller joins it.

When configured Wi-Fi is unavailable and WLED opens its fallback AP, the offline mesh keeps the
AP's configured channel. On ESP32, ESP-NOW uses the disconnected station interface while the phone
uses the AP interface; reconnecting the phone therefore does not restart the mesh. Wi-Fi scanning
and automatic station reconnect are suspended while this fallback is active because channel
changes would partition the mesh. Reboot while infrastructure Wi-Fi is available, or temporarily
disable ESP-NOW sync, to leave this stable offline mode.

The fallback AP is reached at `4.3.2.1`; Bonjour `.local` names are not expected to resolve in this
case.

## JSON interface and bounded diagnostics

An ESP-NOW command is a normal `/json/state` request with `espf: true` and one or more supported
state fields. Optional routing fields are:

- `espd`: exactly 12 hexadecimal MAC digits for one node;
- `espg`: an 8-bit receive-group mask; and
- `espr`: a nonzero request ID, used only for individual acknowledgements.

`esptrim` changes an individually targeted node's output trim. `time`, `timems`, and `espt: true`
inject millisecond wall time and promote that controller as described above.

`/json/info` advertises app-facing capability version 6 in `espf` and exposes `espmesh` with the
local ID, trim, groups, synchronization/recovery diagnostics, recent nodes, and recent individual
acknowledgements. This app capability version is separate from wire version 5.

Memory is fixed rather than proportional to fleet size. The implementation currently tracks 16
remote announcements, 32 recent flood identities, 32 acknowledgements, eight transmit slots,
eight deferred command slots, and four pending state responders. The 16-node roster limit affects
gateway discovery and UI reporting, not whether additional nodes relay and apply broadcasts.
Large 50-100 node deployments therefore require radio-load testing and a larger or redesigned
roster before individual discovery of every node can be promised.

## Regression test checklist

- Fully connected mesh: repeated fleet preset, power, and brightness commands.
- Line or whitelist-simulated topology: commands and time cross every hop.
- Overlapping commands: newer same-field commands supersede older retries; different fields remain
  ordered around preset loading.
- Individual command: only the target applies it and returns an acknowledgement through relays.
- Brightness trim: fleet brightness preserves different per-node output trims.
- Newcomer and ordinary-node reboot: retained state returns without a gateway connection.
- Gateway/root reboot: its new session joins and converges without the phone reconnecting.
- Partition and reunion, including two direct-time nodes: one deterministic root wins.
- Shared Wi-Fi and fallback AP: effects and clock-synchronized playlists remain phase aligned.
- All-node reboot: no stale fleet state is reconstructed.
