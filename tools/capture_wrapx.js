#!/usr/bin/env node

/*
 * Capture before/after wrap-X clips from a WLED device built with
 * -D WLED_ENABLE_CAPTURE_MODE.
 *
 * Example:
 *   node tools/capture_wrapx.js --host 192.168.1.50 --effects tools/capture_wrapx_effects.example.toml
 */

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const { spawn } = require('node:child_process');

function waitForEvent(target, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.off(event, onEvent);
      target.off('error', onError);
    };
    const onEvent = value => {
      cleanup();
      resolve(value);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    target.once(event, onEvent);
    target.once('error', onError);
  });
}

async function writeInput(stream, input) {
  for (const chunk of input) {
    if (!stream.write(chunk)) await waitForEvent(stream, 'drain');
  }
  stream.end();
}

async function runQuiet(command, args, options = {}) {
  let stderr = '';
  const {input, ...spawnOptions} = options;

  const child = spawn(command, args, Object.assign({stdio: ['pipe', 'ignore', 'pipe']}, spawnOptions));
  child.stderr?.on('data', chunk => {
    stderr += chunk;
  });

  const closePromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const details = stderr.trim();
        reject(new Error(`${command} exited with ${code}${details ? `:\n${details}` : ''}`));
      }
    });
  });

  const inputPromise = input ? writeInput(child.stdin, input) : Promise.resolve(child.stdin?.end());
  await Promise.all([closePromise, inputPromise]);
}

function usage() {
  console.log(`Usage: node tools/capture_wrapx.js --host <ip-or-host> [options]

Options:
  --effects <file>  Effect preset TOML or JSON file (default: tools/capture_wrapx_effects.example.toml)
  --out <dir>       Output directory (default: captures/wrapx)
  --seconds <n>     Seconds per clip (default: 20)
  --fps <n>         Capture FPS / fixed effect frame rate (default: 25)
  --scale <n>       Nearest-neighbor video scale (default: 16)
  --bri <n>         Brightness for capture state (default: 128)
  --settle-ms <n>   Drop in-flight liveview frames after each reset (default: 120)
  --frame-timeout-ms <n> Liveview frame timeout (default: 15000)
  --capture-retries <n> Full variant capture retries after liveview timeout (default: 2)
  --wrap-cols <n>   Show n copied edge columns across each X seam (default: 2, 0 disables)
  --font <path>     Font file for comparison titles (default: auto)
  --ffmpeg <path>   ffmpeg executable (default: ffmpeg)
  --encode-jobs <n> Concurrent ffmpeg jobs per effect (default: 2)
  --combined <name> Combined comparison video name (default: all-effects-compare.mp4)
  --resume          Skip effects already completed in capture-performance.csv

The target firmware must report capture support through /json/info. Build with
-D WLED_ENABLE_CAPTURE_MODE before using this tool.
`);
}

function parseArgs(argv) {
  const args = {
    effects: 'tools/capture_wrapx_effects.example.toml',
    out: 'captures/wrapx',
    seconds: 20,
    fps: 25,
    scale: 16,
    bri: 128,
    'settle-ms': 120,
    'frame-timeout-ms': 15000,
    'capture-retries': 2,
    'wrap-cols': 2,
    font: findDefaultFont(),
    ffmpeg: 'ffmpeg',
    'encode-jobs': 2,
    combined: 'all-effects-compare.mp4',
    resume: false
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--help' || key === '-h') {
      usage();
      process.exit(0);
    }
    if (key === '--resume') {
      args.resume = true;
      continue;
    }
    if (!key.startsWith('--') || next === undefined) throw new Error(`Invalid argument: ${key}`);
    args[key.slice(2)] = next;
    i++;
  }

  if (!args.host) throw new Error('Missing --host');
  args.seconds = Number(args.seconds);
  args.fps = Number(args.fps);
  args.scale = Number(args.scale);
  args.bri = Number(args.bri);
  args.settleMs = Number(args['settle-ms']);
  args.frameTimeoutMs = Number(args['frame-timeout-ms']);
  args.captureRetries = Number(args['capture-retries']);
  args.wrapCols = Number(args['wrap-cols']);
  args.encodeJobs = Number(args['encode-jobs']);
  if (!Number.isFinite(args.seconds) || args.seconds <= 0) throw new Error('Invalid --seconds');
  if (!Number.isFinite(args.fps) || args.fps <= 0) throw new Error('Invalid --fps');
  if (!Number.isFinite(args.scale) || args.scale <= 0) throw new Error('Invalid --scale');
  if (!Number.isFinite(args.settleMs) || args.settleMs < 0) throw new Error('Invalid --settle-ms');
  if (!Number.isFinite(args.frameTimeoutMs) || args.frameTimeoutMs <= 0) throw new Error('Invalid --frame-timeout-ms');
  if (!Number.isInteger(args.captureRetries) || args.captureRetries < 0) throw new Error('Invalid --capture-retries');
  if (!Number.isInteger(args.wrapCols) || args.wrapCols < 0) throw new Error('Invalid --wrap-cols');
  if (!Number.isInteger(args.encodeJobs) || args.encodeJobs <= 0) throw new Error('Invalid --encode-jobs');
  return args;
}

function sanitizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'effect';
}

function findDefaultFont() {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
  ];
  return candidates.find(font => fs.existsSync(font)) || '';
}

function formatHost(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return port ? `${host}:${port}` : host;
}

async function resolveHost(host) {
  const url = new URL(`http://${host}`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === 'localhost' || url.hostname.includes(':')) return host;

  const started = Date.now();
  const result = await dns.lookup(url.hostname, {family: 4});
  const resolved = formatHost(result.address, url.port);
  console.log(`Resolved ${url.hostname} to ${result.address} in ${formatDurationShort(Date.now() - started)}`);
  return resolved;
}

function getCaptureVariants() {
  return [
    {key: 'nowrap', label: 'no wrap', suffix: 'nowrap', seg: {wX: false}},
    {key: 'wrapx', label: 'wrap x', suffix: 'wrapx', seg: {wX: true}}
  ];
}

async function loadEffects(file) {
  const text = await fs.promises.readFile(file, 'utf8');
  if (file.endsWith('.toml')) return parseEffectsToml(text);
  if (file.endsWith('.json')) return JSON.parse(text);
  try {
    return JSON.parse(text);
  } catch {
    return parseEffectsToml(text);
  }
}

function parseEffectsToml(text) {
  const effects = [];
  let current = null;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line === '[[effects]]') {
      current = {};
      effects.push(current);
      continue;
    }
    if (!current) throw new Error(`TOML line ${lineIndex + 1}: expected [[effects]] before values`);

    const match = line.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (!match) throw new Error(`TOML line ${lineIndex + 1}: unsupported syntax: ${rawLine}`);
    assignDottedKey(current, match[1], parseTomlValue(match[2], lineIndex + 1));
  }

  return effects;
}

function stripTomlComment(line) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(value, lineNumber) {
  value = value.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('{') && value.endsWith('}')) return parseTomlInlineTable(value.slice(1, -1), lineNumber);
  throw new Error(`TOML line ${lineNumber}: unsupported value: ${value}`);
}

function parseTomlInlineTable(value, lineNumber) {
  const table = {};
  for (const part of splitTomlList(value)) {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (!match) throw new Error(`TOML line ${lineNumber}: unsupported inline table entry: ${part}`);
    assignDottedKey(table, match[1], parseTomlValue(match[2], lineNumber));
  }
  return table;
}

function splitTomlList(value) {
  const parts = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === ',' && !inString) {
      const part = value.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const part = value.slice(start).trim();
  if (part) parts.push(part);
  return parts;
}

function assignDottedKey(target, key, value) {
  const parts = key.split('.');
  let object = target;
  while (parts.length > 1) {
    const part = parts.shift();
    object[part] ||= {};
    object = object[part];
  }
  object[parts[0]] = value;
}

async function postJson(host, pathName, body) {
  const res = await fetch(`http://${host}${pathName}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathName}`);
  return res.json();
}

async function getJson(host, pathName) {
  const res = await fetch(`http://${host}${pathName}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathName}`);
  return res.json();
}

async function assertCaptureModeAvailable(host) {
  const info = await getJson(host, '/json/info');
  if (!info.capture) {
    throw new Error('Firmware does not report capture mode support. Rebuild and flash WLED with -D WLED_ENABLE_CAPTURE_MODE.');
  }
}

async function assertSegmentState(host, expected) {
  const state = await getJson(host, '/json/state');
  const segments = Array.isArray(state.seg) ? state.seg : [];
  const segment = segments.find(item => item.id === expected.id) || segments[expected.id];
  if (!segment) throw new Error(`Segment ${expected.id} was not returned by /json/state`);

  for (const key of ['fx', 'pal', 'wX']) {
    if (expected[key] === undefined) continue;
    if (segment[key] !== expected[key]) {
      throw new Error(`Segment ${expected.id} ${key} is ${segment[key]}, expected ${expected[key]}`);
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class LiveviewFrameTimeoutError extends Error {
  constructor(frameIndex, timeoutMs) {
    super(`Timed out waiting for liveview frame ${frameIndex + 1} after ${timeoutMs}ms`);
    this.name = 'LiveviewFrameTimeoutError';
    this.frameIndex = frameIndex;
  }
}

async function openLiveWebSocket(host) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('This script needs a Node.js runtime with global WebSocket support.');
  }

  const waiters = [];
  let ws = null;

  async function connect() {
    ws = new WebSocket(`ws://${host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({lv: true}));
    });

    ws.addEventListener('message', async (event) => {
      let data = event.data;
      if (data && typeof data.arrayBuffer === 'function') data = await data.arrayBuffer();
      if (!(data instanceof ArrayBuffer)) return;

      const frame = new Uint8Array(data);
      if (frame[0] !== 76 || frame[1] !== 2) return; // 'L', matrix liveview packet v2
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
    });

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, {once: true});
      ws.addEventListener('error', reject, {once: true});
    });
  }

  await connect();

  function clearWaiters(error) {
    while (waiters.length) waiters.shift().reject(error);
  }

  return {
    get ws() {
      return ws;
    },
    async reconnect() {
      clearWaiters(new Error('Liveview WebSocket reconnected'));
      try {
        ws?.close();
      } catch {}
      await connect();
    },
    close() {
      clearWaiters(new Error('Liveview WebSocket closed'));
      ws?.close();
    },
    nextFrame(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        let timeout;
        const waiter = {resolve, reject};
        waiter.resolve = (frame) => {
          clearTimeout(timeout);
          resolve(frame);
        };
        waiters.push(waiter);
        timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for liveview frame'));
        }, timeoutMs);
      });
    }
  };
}

function parseLiveFrame(packet) {
  const width = packet[2];
  const height = packet[3];
  const expected = 4 + width * height * 3;
  if (packet.length < expected) {
    throw new Error(`Short liveview packet: ${packet.length}, expected ${expected}`);
  }
  return {
    width,
    height,
    pixels: Buffer.from(packet.slice(4, expected))
  };
}

async function requestCaptureFrame({live, timeoutMs, frameIndex}) {
  const pending = live.nextFrame(timeoutMs);
  live.ws.send(JSON.stringify({capture: {next: true}}));
  try {
    return await pending;
  } catch (error) {
    if (error.message === 'Timed out waiting for liveview frame') {
      throw new LiveviewFrameTimeoutError(frameIndex, timeoutMs);
    }
    throw error;
  }
}

async function captureVariantOnce({host, live, effect, variant, fps, seconds, bri, settleMs, frameTimeoutMs}) {
  const started = Date.now();
  const frames = [];
  const count = Math.round(fps * seconds);
  const effectState = effect.state || {};
  const seg = Object.assign(
    {id: 0, fx: effect.id, fxdef: true},
    effectState.seg || {},
    effect.seg || {},
    variant.seg || {}
  );
  const state = Object.assign({
    on: true,
    bri,
    tt: 0,
    tb: 0
  }, effectState, {
    seg,
    capture: Object.assign({
      on: true,
      step: true,
      skipShow: true,
      fps,
      reset: true
    }, effectState.capture || {})
  });

  const setupStarted = Date.now();
  const setupParts = {};

  const solidStarted = Date.now();
  await postJson(host, '/json', {
    on: true,
    bri,
    tt: 0,
    tb: 0,
    seg: Object.assign({id: seg.id, fx: 0, fxdef: false}, variant.seg || {}),
    capture: {
      on: true,
      step: true,
      skipShow: true,
      fps
    }
  });
  setupParts.solidMs = Date.now() - solidStarted;

  const targetStarted = Date.now();
  await postJson(host, '/json', state);
  setupParts.targetMs = Date.now() - targetStarted;

  const segOverrides = Object.assign(
    {id: seg.id},
    effectState.seg || {},
    effect.seg || {},
    variant.seg || {}
  );
  delete segOverrides.fx;
  delete segOverrides.fxdef;
  const overrideStarted = Date.now();
  await postJson(host, '/json', {tt: 0, seg: segOverrides});
  setupParts.overrideMs = Date.now() - overrideStarted;

  const assertStarted = Date.now();
  await assertSegmentState(host, Object.assign({id: seg.id, fx: effect.id}, segOverrides));
  setupParts.assertMs = Date.now() - assertStarted;
  const setupMs = Date.now() - setupStarted;

  const settleStarted = Date.now();
  if (settleMs) await delay(settleMs);
  const settleActualMs = Date.now() - settleStarted;

  let width = 0;
  let height = 0;
  const framesStarted = Date.now();
  for (let i = 0; i < count; i++) {
    const frame = parseLiveFrame(await requestCaptureFrame({live, timeoutMs: frameTimeoutMs, frameIndex: i}));
    if (!width) {
      width = frame.width;
      height = frame.height;
    } else if (frame.width !== width || frame.height !== height) {
      throw new Error(`Matrix size changed during capture: ${width}x${height} -> ${frame.width}x${frame.height}`);
    }
    frames.push(frame.pixels);
  }
  const frameMs = Date.now() - framesStarted;
  const statsStarted = Date.now();
  const info = await getJson(host, '/json/info');
  const statsMs = Date.now() - statsStarted;
  const captureStats = info.captureStats || null;

  return {
    width,
    height,
    frames,
    timing: {
      setupMs,
      settleMs: settleActualMs,
      frameMs,
      totalMs: Date.now() - started,
      frameCount: count,
      effectiveFps: frameMs ? count * 1000 / frameMs : 0,
      statsMs,
      captureStats,
      setupParts
    }
  };
}

async function captureVariant({host, live, effect, variant, fps, seconds, bri, settleMs, frameTimeoutMs, captureRetries}) {
  for (let attempt = 0; attempt <= captureRetries; attempt++) {
    try {
      return await captureVariantOnce({host, live, effect, variant, fps, seconds, bri, settleMs, frameTimeoutMs});
    } catch (error) {
      if (!(error instanceof LiveviewFrameTimeoutError) || attempt >= captureRetries) throw error;
      console.warn(`${effect.id} ${effect.name || ''}: ${variant.label} timed out at frame ${error.frameIndex + 1}; restarting capture (${attempt + 1}/${captureRetries})`);
      await live.reconnect();
    }
  }
  throw new Error('Capture retry loop exited unexpectedly');
}

function addWrapPreview(capture, cols) {
  const copyCols = Math.min(cols, capture.width);
  if (!copyCols) return capture;

  const width = capture.width + copyCols * 2;
  const height = capture.height;
  const srcStride = capture.width * 3;
  const dstStride = width * 3;
  const imageX = copyCols;
  const rightWrapX = imageX + capture.width;
  const frames = [];

  for (const frame of capture.frames) {
    const dst = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const srcRow = y * srcStride;
      const dstRow = y * dstStride;

      frame.copy(dst, dstRow, srcRow + (capture.width - copyCols) * 3, srcRow + srcStride);
      frame.copy(dst, dstRow + imageX * 3, srcRow, srcRow + srcStride);
      frame.copy(dst, dstRow + rightWrapX * 3, srcRow, srcRow + copyCols * 3);
    }
    frames.push(dst);
  }

  return {
    width,
    height,
    frames,
    timing: capture.timing,
    seamLines: [
      {x: imageX, align: 'before'},
      {x: rightWrapX, align: 'at'}
    ]
  };
}

function combineCaptures(items) {
  if (!items.length) throw new Error('Cannot combine an empty capture list');
  const first = items[0].capture;
  for (const item of items) {
    const capture = item.capture;
    if (capture.width !== first.width || capture.height !== first.height || capture.frames.length !== first.frames.length) {
      throw new Error('Cannot combine captures with different dimensions or frame counts');
    }
  }

  const gutter = 1;
  const width = items.reduce((sum, item) => sum + item.capture.width, 0) + gutter * (items.length - 1);
  const height = first.height;
  const frames = [];
  const dstStride = width * 3;
  const seamLines = [];
  const labels = [];

  for (let f = 0; f < first.frames.length; f++) {
    const dst = Buffer.alloc(width * height * 3);
    let xOffset = 0;
    for (let y = 0; y < height; y++) {
      const dstRow = y * dstStride;
      xOffset = 0;
      for (const item of items) {
        const capture = item.capture;
        const srcStride = capture.width * 3;
        capture.frames[f].copy(dst, dstRow + xOffset * 3, y * srcStride, (y + 1) * srcStride);
        xOffset += capture.width;
        if (xOffset < width) {
          dst.fill(0, dstRow + xOffset * 3, dstRow + (xOffset + gutter) * 3);
          xOffset += gutter;
        }
      }
    }
    frames.push(dst);
  }

  let xOffset = 0;
  for (const item of items) {
    seamLines.push(...(item.capture.seamLines || []).map(line => ({...line, x: line.x + xOffset})));
    labels.push({text: item.label, x: xOffset + item.capture.width / 2});
    xOffset += item.capture.width + gutter;
  }

  return {width, height, frames, seamLines, labels};
}

function escapeFilterValue(text) {
  return String(text).replace(/[\\:',[\]]/g, '\\$&');
}

function escapeConcatPath(file) {
  return String(file).replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
}

function escapeCsvValue(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === ',') {
      values.push(value);
      value = '';
    } else if (ch === '"') {
      quoted = true;
    } else {
      value += ch;
    }
  }
  values.push(value);
  return values;
}

const PERFORMANCE_CSV_HEADERS = [
  'effectId',
  'effectName',
  'variant',
  'variantLabel',
  'requestedFrames',
  'capturedFrames',
  'hostFrameMs',
  'hostEffectiveFps',
  'effectFrames',
  'effectAvgUs',
  'effectMinUs',
  'effectMaxUs'
];

function getPerformanceCsvPath(outDir) {
  return path.join(outDir, 'capture-performance.csv');
}

async function readPerformanceCsv(outDir) {
  const csvPath = getPerformanceCsvPath(outDir);
  let text;
  try {
    text = await fs.promises.readFile(csvPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function createPerformanceCsvWriter(outDir) {
  const outPath = getPerformanceCsvPath(outDir);
  let initialized = false;

  return {
    outPath,
    async initialize(rows = []) {
      await fs.promises.mkdir(outDir, {recursive: true});
      const body = rows.map(row => PERFORMANCE_CSV_HEADERS.map(header => escapeCsvValue(row[header])).join(','));
      await fs.promises.writeFile(outPath, `${PERFORMANCE_CSV_HEADERS.join(',')}\n${body.length ? `${body.join('\n')}\n` : ''}`);
      initialized = true;
    },
    async append(row) {
      if (!initialized) {
        await this.initialize();
      }
      await fs.promises.appendFile(outPath, `${PERFORMANCE_CSV_HEADERS.map(header => escapeCsvValue(row[header])).join(',')}\n`);
    }
  };
}

function formatTimestamp(seconds) {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDurationShort(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

function createProgress(plan) {
  const started = Date.now();
  const groups = new Map(plan.map(group => [
    group.key,
    Object.assign({done: 0, elapsed: 0}, group)
  ]));
  const active = new Map();

  function totalDone() {
    let done = 0;
    for (const group of groups.values()) done += group.done;
    return done;
  }

  function totalPlanned() {
    let total = 0;
    for (const group of groups.values()) total += group.total;
    return total;
  }

  function summary() {
    const elapsed = Date.now() - started;
    let estimatedRemaining = 0;
    let completeEstimate = true;
    let estimatedDone = 0;
    let estimatedTotal = 0;

    for (const group of groups.values()) {
      if (group.total === 0) continue;
      if (!group.estimate) continue;

      let activeCount = 0;
      let activeElapsed = 0;
      for (const step of active.values()) {
        if (step.key !== group.key) continue;
        activeCount++;
        activeElapsed += Date.now() - step.started;
      }

      estimatedDone += group.done;
      estimatedTotal += group.total;
      const observedCount = group.done + activeCount;
      const observedElapsed = group.elapsed + activeElapsed;
      if (observedCount > 0) {
        const average = observedElapsed / observedCount;
        const activeRemaining = activeCount ? Math.max(0, activeCount * average - activeElapsed) : 0;
        estimatedRemaining += Math.max(0, group.total - group.done - activeCount) * average + activeRemaining;
      } else {
        completeEstimate = false;
      }
    }

    const total = completeEstimate ? formatDuration(elapsed + estimatedRemaining) : 'estimating';
    const remaining = completeEstimate ? formatDuration(estimatedRemaining) : 'estimating';
    return `record ${estimatedDone}/${estimatedTotal} steps ${totalDone()}/${totalPlanned()} elapsed ${formatDuration(elapsed)} total ${total} remaining ${remaining}`;
  }

  return {
    start(key, label) {
      if (!groups.has(key)) throw new Error(`Unknown progress group: ${key}`);
      const token = Symbol(label);
      active.set(token, {key, label, started: Date.now()});
      console.log(`[${summary()}] ${label}`);
      return token;
    },
    done(token, label) {
      const step = active.get(token);
      if (!step) throw new Error('Progress done without active step');
      const group = groups.get(step.key);
      group.done++;
      group.elapsed += Date.now() - step.started;
      label ||= step.label;
      active.delete(token);
      console.log(`[${summary()}] done ${label}`);
    }
  };
}

async function withProgress(progress, key, label, task) {
  const token = progress.start(key, label);
  try {
    return await task();
  } finally {
    progress.done(token, label);
  }
}

function createTaskQueue(limit) {
  const tasks = [];
  let active = 0;
  let closed = false;
  let failed = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function maybeDone() {
    if (closed && !failed && active === 0 && tasks.length === 0) resolveDone();
  }

  function pump() {
    while (!failed && active < limit && tasks.length) {
      const item = tasks.shift();
      active++;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, error => {
          failed = true;
          item.reject(error);
          rejectDone(error);
        })
        .finally(() => {
          active--;
          pump();
          maybeDone();
        });
    }
  }

  return {
    add(task) {
      if (closed) throw new Error('Cannot add tasks to a closed queue');
      const promise = new Promise((resolve, reject) => {
        tasks.push({task, resolve, reject});
        pump();
      });
      promise.catch(() => {}); // queue.done carries the failure to the main flow.
      return promise;
    },
    close() {
      closed = true;
      maybeDone();
      return done;
    },
    done
  };
}

async function writeVideo({ffmpeg, outPath, capture, fps, scale, title, labels, font}) {
  await fs.promises.mkdir(path.dirname(outPath), {recursive: true});
  const scaled = `${capture.width * scale}:${capture.height * scale}`;
  const filters = [`scale=${scaled}:flags=neighbor`];
  for (const line of capture.seamLines || []) {
    const x = line.align === 'before' ? line.x * scale - 1 : line.x * scale;
    filters.push(`drawbox=x=${x}:y=0:w=1:h=ih:color=gray:t=fill`);
  }
  if (title || labels?.length) {
    const titleHeight = title ? Math.max(24, Math.round(scale * 2.5)) : 0;
    const labelHeight = labels?.length ? Math.max(20, Math.round(scale * 2)) : 0;
    const fontSize = Math.max(14, Math.round(Math.max(titleHeight, labelHeight) * 0.55));
    const fontOption = font ? `:fontfile='${escapeFilterValue(font)}'` : '';
    filters.push(`pad=iw:ih+${titleHeight + labelHeight}:0:${titleHeight}:color=black`);
    if (title) {
      filters.push(`drawtext=text='${escapeFilterValue(title)}'${fontOption}:x=(w-text_w)/2:y=(${titleHeight}-text_h)/2:fontsize=${fontSize}:fontcolor=white:expansion=none`);
    }
    for (const label of labels || []) {
      filters.push(`drawtext=text='${escapeFilterValue(label.text)}'${fontOption}:x=${label.x * scale}-text_w/2:y=h-${labelHeight}+(${labelHeight}-text_h)/2:fontsize=${fontSize}:fontcolor=white:expansion=none`);
    }
  }

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pixel_format', 'rgb24',
    '-video_size', `${capture.width}x${capture.height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-vf', filters.join(','),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];

  await runQuiet(ffmpeg, args, {input: capture.frames});
}

async function writeCombinedComparison({ffmpeg, outDir, outName, clips, timestamps}) {
  if (!clips.length) return;

  const outPath = path.join(outDir, outName);
  const listPath = path.join(outDir, `${path.basename(outName, path.extname(outName))}.ffconcat`);
  const indexPath = path.join(outDir, `${path.basename(outName, path.extname(outName))}-timestamps.txt`);

  await fs.promises.writeFile(
    listPath,
    clips.map(file => `file '${escapeConcatPath(path.resolve(file))}'`).join('\n') + '\n'
  );
  await fs.promises.writeFile(
    indexPath,
    timestamps.map(item => `${formatTimestamp(item.time)} ${item.title}`).join('\n') + '\n'
  );

  await runQuiet(ffmpeg, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath
  ]);

  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${indexPath}`);
}

function enqueueVariantVideo({queue, args, title, name, result, progress}) {
  const outPath = path.join(args.out, `${name}-${result.variant.suffix}.mp4`);
  result.videoPath = outPath;
  result.videoQueued = true;
  queue.add(() => withProgress(progress, 'ffmpeg', `${title}: encode ${result.variant.label}`, () => writeVideo({
    ffmpeg: args.ffmpeg,
    outPath,
    capture: result.capture,
    fps: args.fps,
    scale: args.scale,
    font: args.font
  })));
}

function enqueueComparisonVideo({queue, args, title, name, results, progress}) {
  const comparison = combineCaptures(results.map(result => ({
    capture: result.capture,
    label: result.variant.label
  })));
  const outPath = path.join(args.out, `${name}-compare.mp4`);
  queue.add(() => withProgress(progress, 'ffmpeg', `${title}: encode comparison`, () => writeVideo({
    ffmpeg: args.ffmpeg,
    outPath,
    capture: comparison,
    fps: args.fps,
    scale: args.scale,
    title,
    labels: comparison.labels,
    font: args.font
  })));
  return outPath;
}

function getResumeState({rows, effects, variants, outDir}) {
  const completed = new Set();
  const keptRows = [];
  const rowsByEffectVariant = new Map();

  for (const row of rows) {
    if (!row.effectId || !row.variant) continue;
    rowsByEffectVariant.set(`${row.effectId}:${row.variant}`, row);
  }

  for (const effect of effects) {
    if (!Number.isInteger(effect.id)) continue;
    const name = sanitizeName(effect.name || effect.id);
    const comparePath = path.join(outDir, `${name}-compare.mp4`);
    const effectRows = variants.map(variant => rowsByEffectVariant.get(`${effect.id}:${variant.key}`));
    if (effectRows.every(Boolean) && fs.existsSync(comparePath)) {
      completed.add(String(effect.id));
      keptRows.push(...effectRows);
    }
  }

  return {completed, rows: keptRows};
}

async function main() {
  const args = parseArgs(process.argv);
  const effects = await loadEffects(args.effects);
  if (!Array.isArray(effects)) throw new Error('Effects file must contain a TOML effects list or JSON array');
  const variants = getCaptureVariants();
  const resumeState = args.resume ? getResumeState({
    rows: await readPerformanceCsv(args.out),
    effects,
    variants,
    outDir: args.out
  }) : {completed: new Set(), rows: []};
  const remainingEffects = effects.filter(effect => !resumeState.completed.has(String(effect.id)));
  const progress = createProgress([
    {key: 'init', total: remainingEffects.length ? 1 : 0},
    {key: 'record', total: remainingEffects.length * variants.length, estimate: true},
    {key: 'ffmpeg', total: remainingEffects.length * (variants.length + 1) + 1}
  ]);

  let host = null;
  let live = null;
  if (remainingEffects.length) {
    const initProgress = progress.start('init', 'initialize capture session');
    host = await resolveHost(args.host);
    await assertCaptureModeAvailable(host);
    live = await openLiveWebSocket(host);
    progress.done(initProgress, 'initialize capture session');
  }

  const comparisonClips = [];
  const timestamps = [];
  const performanceCsv = createPerformanceCsvWriter(args.out);
  await performanceCsv.initialize(resumeState.rows);
  if (args.resume) {
    console.log(`Resume: skipping ${resumeState.completed.size} completed effect(s), recording ${remainingEffects.length}`);
  }
  let activeProcessing = null;
  let processingError = null;

  async function waitForProcessingSlot() {
    if (activeProcessing) {
      await activeProcessing;
      activeProcessing = null;
    }
    if (processingError) {
      const error = processingError;
      processingError = null;
      throw error;
    }
  }

  try {
    for (const effect of effects) {
      if (!Number.isInteger(effect.id)) throw new Error(`Effect missing numeric id: ${JSON.stringify(effect)}`);
      const name = sanitizeName(effect.name || effect.id);
      const title = `${effect.id} ${effect.name || name}`;
      if (resumeState.completed.has(String(effect.id))) {
        console.log(`Skipping ${title} (resume)`);
        timestamps.push({time: comparisonClips.length * args.seconds, title: `${effect.id} ${effect.name || name}`});
        comparisonClips.push(path.join(args.out, `${name}-compare.mp4`));
        continue;
      }
      console.log(`Capturing ${title}`);
      const results = [];
      let queue = null;

      async function ensureQueue() {
        if (queue) return queue;
        await waitForProcessingSlot();
        queue = createTaskQueue(args.encodeJobs);
        const processing = queue.done.catch(error => {
          processingError = error;
        });
        activeProcessing = processing;
        processing.finally(() => {
          if (activeProcessing === processing) activeProcessing = null;
        });
        return queue;
      }

      for (const variant of variants) {
        const variantRecordStarted = Date.now();
        const token = progress.start('record', `${title}: capture ${variant.label}`);
        const rawCapture = await captureVariant({
          host,
          live,
          effect,
          variant,
          fps: args.fps,
          seconds: args.seconds,
          bri: args.bri,
          settleMs: args.settleMs,
          frameTimeoutMs: args.frameTimeoutMs,
          captureRetries: args.captureRetries
        });
        const previewStarted = Date.now();
        const capture = addWrapPreview(rawCapture, args.wrapCols);
        const previewMs = Date.now() - previewStarted;
        progress.done(token, `${title}: capture ${variant.label}`);
        const totalMs = Date.now() - variantRecordStarted;
        const timing = rawCapture.timing;
        const setup = timing.setupParts;
        const stats = timing.captureStats;
        const effectStats = stats ? `, effect ${stats.effectAvgUs}us avg/${stats.effectMinUs}us min/${stats.effectMaxUs}us max over ${stats.effectFrames} frames` : '';
        console.log(`${title}: ${variant.label} recording took ${formatDurationShort(totalMs)} (setup ${formatDurationShort(timing.setupMs)}: solid ${formatDurationShort(setup.solidMs)}, target ${formatDurationShort(setup.targetMs)}, override ${formatDurationShort(setup.overrideMs)}, assert ${formatDurationShort(setup.assertMs)}; settle ${formatDurationShort(timing.settleMs)}, frames ${formatDurationShort(timing.frameMs)} @ ${timing.effectiveFps.toFixed(1)} fps, stats ${formatDurationShort(timing.statsMs)}, preview ${formatDurationShort(previewMs)}${effectStats})`);
        await performanceCsv.append({
          effectId: effect.id,
          effectName: effect.name || name,
          variant: variant.key,
          variantLabel: variant.label,
          requestedFrames: timing.frameCount,
          capturedFrames: capture.frames.length,
          hostFrameMs: timing.frameMs,
          hostEffectiveFps: timing.effectiveFps.toFixed(2),
          effectFrames: stats?.effectFrames ?? '',
          effectAvgUs: stats?.effectAvgUs ?? '',
          effectMinUs: stats?.effectMinUs ?? '',
          effectMaxUs: stats?.effectMaxUs ?? ''
        });

        const result = {variant, capture, videoQueued: false};
        results.push(result);

        if (!activeProcessing || queue) {
          enqueueVariantVideo({queue: await ensureQueue(), args, title, name, result, progress});
        }
      }

      const processingQueue = await ensureQueue();
      for (const result of results) {
        if (!result.videoQueued) enqueueVariantVideo({queue: processingQueue, args, title, name, result, progress});
      }

      const comparePath = enqueueComparisonVideo({queue: processingQueue, args, title, name, results, progress});
      processingQueue.close();

      timestamps.push({time: comparisonClips.length * args.seconds, title: `${effect.id} ${effect.name || name}`});
      comparisonClips.push(comparePath);
    }
  } finally {
    if (host) await postJson(host, '/json', {capture: {on: false}, v: false}).catch(() => {});
    if (live) live.ws.close();
  }

  await waitForProcessingSlot();
  console.log(`Wrote ${performanceCsv.outPath}`);
  const combineProgress = progress.start('ffmpeg', 'combine comparison video');
  await writeCombinedComparison({
    ffmpeg: args.ffmpeg,
    outDir: args.out,
    outName: args.combined,
    clips: comparisonClips,
    timestamps
  });
  progress.done(combineProgress, 'combine comparison video');
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
