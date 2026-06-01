#!/usr/bin/env node

/*
 * Quickly switch a WLED segment to an effect and optionally override effect
 * parameters.
 *
 * Examples:
 *   node tools/set_wled_effect.js --host wled-dev.local --effect 180
 *   node tools/set_wled_effect.js --host wled-dev.local --effect Hiphotic --pal 4 --wrap-x
 *   node tools/set_wled_effect.js --host wled-dev.local --effect 124 --sx 128 --ix 180 --seg-json '{"pal":4}'
 *   node tools/set_wled_effect.js --host wled-dev.local --effect Hiphotic --settings 'seg = { pal = 4 }'
 */

const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASELINE_FILE = 'captures/wrapx/effect-defaults.json';
const DEFAULT_SEGMENT_COLORS = [[255, 170, 0], [0, 0, 0], [0, 0, 0]];
const SEGMENT_DELTA_KEYS = [
  'sx', 'ix', 'pal',
  'col',
  'c1', 'c2', 'c3',
  'o1', 'o2', 'o3',
  'wX',
  'rev', 'mi', 'rY', 'mY', 'tp'
];

function usage() {
  console.log(`Usage: node tools/set_wled_effect.js --host <ip-or-host> --effect <id-or-name> [options]

Options:
  --seg <id>          Segment id (default: 0)
  --effect <id|name>  Effect id, exact name, or unique case-insensitive substring
  --bri <n>           Global brightness
  --tt <n>            Transition time in WLED API units (default: 0)
  --no-defaults       Do not force effect defaults before applying overrides
  --delta             Print current segment delta to last saved defaults; does not change WLED
  --baseline-file <path>
                     Default snapshot file (default: ${DEFAULT_BASELINE_FILE})

Effect/segment overrides:
  --sx, --speed <n>       Speed
  --ix, --intensity <n>   Intensity
  --pal, --palette <n>    Palette
  --c1 <n> --c2 <n> --c3 <n>
  --o1 <bool> --o2 <bool> --o3 <bool>
  --wrap-x / --no-wrap-x
  --rev <bool> --mi <bool> --rY <bool> --mY <bool> --tp <bool>
  --seg-json <json>       Extra raw segment fields, applied after defaults
  --state-json <json>     Extra raw top-level state fields
  --settings <json|toml>   Apply delta output, e.g. '{"seg":{"pal":4}}'
                          or 'seg = { pal = 4 }'

By default this forces effect defaults reliably by switching the segment to Solid,
then to the target effect with fxdef=true, then applying any overrides. The
default segment state is saved so --delta can compare after tuning in the UI.
`);
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseJsonOption(name, value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error.message}`);
  }
}

function assignDottedKey(target, key, value) {
  const parts = key.split('.');
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    current[part] ||= {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function parseTomlValue(value, optionName) {
  const text = value.trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text.startsWith('[') && text.endsWith(']')) return JSON.parse(text);
  if (text.startsWith('{') && text.endsWith('}')) return parseTomlInlineTable(text.slice(1, -1), optionName);
  throw new Error(`Invalid ${optionName}: unsupported TOML value '${value}'`);
}

function splitTomlInlineParts(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parseTomlInlineTable(value, optionName) {
  const table = {};
  for (const rawPart of splitTomlInlineParts(value)) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (!match) throw new Error(`Invalid ${optionName}: unsupported TOML inline table entry '${part}'`);
    assignDottedKey(table, match[1], parseTomlValue(match[2], optionName));
  }
  return table;
}

function parseSettingsOption(name, value) {
  let parsed;
  const text = value.trim();
  if (text.startsWith('{') && text.includes(':')) {
    parsed = parseJsonOption(name, text);
  } else {
    const match = text.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (match) {
      parsed = {};
      assignDottedKey(parsed, match[1], parseTomlValue(match[2], name));
    } else if (text.startsWith('{') && text.endsWith('}')) {
      parsed = {seg: parseTomlInlineTable(text.slice(1, -1), name)};
    } else {
      throw new Error(`Invalid ${name}: expected JSON object or TOML assignment`);
    }
  }

  if (parsed.seg !== undefined) {
    if (!parsed.seg || typeof parsed.seg !== 'object' || Array.isArray(parsed.seg)) {
      throw new Error(`Invalid ${name}: seg must be an object`);
    }
    const {seg, ...state} = parsed;
    return {seg, state};
  }

  return {seg: parsed, state: {}};
}

function readValue(argv, index, key) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
  return value;
}

function parseArgs(argv) {
  const args = {
    seg: 0,
    tt: 0,
    defaults: true,
    delta: false,
    baselineFile: DEFAULT_BASELINE_FILE,
    segJson: {},
    stateJson: {},
    overrides: {}
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') {
      usage();
      process.exit(0);
    }
    if (key === '--no-defaults') {
      args.defaults = false;
      continue;
    }
    if (key === '--delta') {
      args.delta = true;
      continue;
    }
    if (key === '--wrap-x') {
      args.overrides.wX = true;
      continue;
    }
    if (key === '--no-wrap-x') {
      args.overrides.wX = false;
      continue;
    }

    const value = readValue(argv, i, key);
    i++;
    switch (key) {
      case '--host':
        args.host = value;
        break;
      case '--seg':
        args.seg = Number(value);
        break;
      case '--effect':
      case '--fx':
        args.effect = value;
        break;
      case '--bri':
        args.bri = Number(value);
        break;
      case '--tt':
        args.tt = Number(value);
        break;
      case '--baseline-file':
        args.baselineFile = value;
        break;
      case '--sx':
      case '--speed':
        args.overrides.sx = Number(value);
        break;
      case '--ix':
      case '--intensity':
        args.overrides.ix = Number(value);
        break;
      case '--pal':
      case '--palette':
        args.overrides.pal = Number(value);
        break;
      case '--c1':
      case '--c2':
      case '--c3':
        args.overrides[key.slice(2)] = Number(value);
        break;
      case '--o1':
      case '--o2':
      case '--o3':
      case '--rev':
      case '--mi':
      case '--rY':
      case '--mY':
      case '--tp':
        args.overrides[key.slice(2)] = parseBool(value);
        break;
      case '--seg-json':
        args.segJson = Object.assign(args.segJson, parseJsonOption(key, value));
        break;
      case '--state-json':
        args.stateJson = Object.assign(args.stateJson, parseJsonOption(key, value));
        break;
      case '--settings': {
        const settings = parseSettingsOption(key, value);
        args.stateJson = Object.assign(args.stateJson, settings.state);
        args.segJson = Object.assign(args.segJson, settings.seg);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!args.host) throw new Error('Missing --host');
  if (args.effect === undefined) throw new Error('Missing --effect');
  if (!Number.isInteger(args.seg) || args.seg < 0) throw new Error('Invalid --seg');
  if (!Number.isFinite(args.tt) || args.tt < 0) throw new Error('Invalid --tt');
  if (args.bri !== undefined && (!Number.isInteger(args.bri) || args.bri < 0 || args.bri > 255)) throw new Error('Invalid --bri');

  for (const [key, value] of Object.entries(args.overrides)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 255)) {
      throw new Error(`Invalid --${key}: expected 0..255`);
    }
  }

  return args;
}

function formatHost(hostname, port) {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return port ? `${host}:${port}` : host;
}

async function resolveHost(host) {
  const url = new URL(`http://${host}`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === 'localhost' || url.hostname.includes(':')) return host;

  const result = await dns.lookup(url.hostname, {family: 4});
  return formatHost(result.address, url.port);
}

async function requestJson(host, pathName, options = {}) {
  const response = await fetch(`http://${host}${pathName}`, options);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${pathName} failed with ${response.status}${text ? `: ${text}` : ''}`);
  }
  return response.json();
}

async function getJson(host, pathName) {
  return requestJson(host, pathName);
}

async function postJson(host, pathName, body) {
  return requestJson(host, pathName, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
}

function normalizeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function resolveEffectId(host, effect) {
  const effects = await getJson(host, '/json/eff');
  if (/^\d+$/.test(String(effect))) {
    const id = Number(effect);
    return {id, name: effects[id] || String(id)};
  }

  const wanted = normalizeName(effect);
  const exact = effects.findIndex(name => normalizeName(name) === wanted);
  if (exact >= 0) return {id: exact, name: effects[exact]};

  const matches = effects
    .map((name, id) => ({id, name}))
    .filter(item => normalizeName(item.name).includes(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Effect name is ambiguous: ${matches.map(item => `${item.id} ${item.name}`).join(', ')}`);
  }
  throw new Error(`Effect not found: ${effect}`);
}

function parseCStringLiteral(value) {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function findLocalEffectMetadata(effectName) {
  const fxPath = path.join(__dirname, '..', 'wled00', 'FX.cpp');
  let source;
  try {
    source = fs.readFileSync(fxPath, 'utf8');
  } catch {
    return '';
  }

  const wanted = normalizeName(effectName);
  const pattern = /static const char\s+_data_[^\n=]+=\s*"((?:\\"|[^"])*)";/g;
  for (const match of source.matchAll(pattern)) {
    const metadata = parseCStringLiteral(match[1]);
    const name = metadata.split('@', 1)[0];
    if (normalizeName(name) === wanted) return metadata;
  }
  return '';
}

function extractMetadataDefault(metadata, key) {
  const defaults = metadata.slice(metadata.lastIndexOf(';') + 1);
  const pattern = new RegExp(`(?:^|,)${key}=(-?\\d+)`);
  const match = defaults.match(pattern);
  return match ? Number(match[1]) : null;
}

function getEffectDefaultPalette(effectName) {
  const metadata = findLocalEffectMetadata(effectName);
  const pal = metadata ? extractMetadataDefault(metadata, 'pal') : null;
  return Number.isInteger(pal) && pal >= 0 && pal <= 255 ? pal : 0;
}

function baseState(args) {
  const state = Object.assign({on: true, tt: args.tt}, args.stateJson);
  if (args.bri !== undefined) state.bri = args.bri;
  return state;
}

function getSegment(state, id) {
  const segment = Array.isArray(state.seg) ? state.seg.find(item => item.id === id) : null;
  if (!segment) throw new Error(`Segment ${id} was not returned by /json/state`);
  return segment;
}

function baselineKey(fx, segId) {
  return `${fx}:${segId}`;
}

function pickSegmentFields(segment) {
  const result = {};
  for (const key of SEGMENT_DELTA_KEYS) {
    if (segment[key] !== undefined) result[key] = segment[key];
  }
  return result;
}

async function readBaselineFile(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {baselines: {}};
    throw error;
  }
}

async function saveDefaultBaseline(file, {fx, effect, segId, segment}) {
  const data = await readBaselineFile(file);
  data.baselines ||= {};
  data.baselines[baselineKey(fx, segId)] = {
    fx,
    effect,
    seg: segId,
    capturedAt: new Date().toISOString(),
    defaults: pickSegmentFields(segment)
  };
  await fs.promises.mkdir(path.dirname(file), {recursive: true});
  await fs.promises.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

function diffSegmentDefaults(defaults, current) {
  const delta = {};
  for (const key of SEGMENT_DELTA_KEYS) {
    if (current[key] === undefined) continue;
    if (JSON.stringify(defaults[key]) !== JSON.stringify(current[key])) delta[key] = current[key];
  }
  return delta;
}

function tomlValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function inlineTomlObject(object) {
  return `{ ${Object.entries(object).map(([key, value]) => `${key} = ${tomlValue(value)}`).join(', ')} }`;
}

async function applyEffect(host, args, effectInfo) {
  const fx = effectInfo.id;
  const overrides = Object.assign({}, args.segJson, args.overrides);
  let defaultsSegment = null;

  if (args.defaults) {
    const defaultPalette = getEffectDefaultPalette(effectInfo.name);
    await postJson(host, '/json', Object.assign(baseState(args), {
      seg: {id: args.seg, fx: 0, fxdef: false}
    }));
    await postJson(host, '/json', Object.assign(baseState(args), {
      seg: {id: args.seg, fx, fxdef: true, pal: defaultPalette, col: DEFAULT_SEGMENT_COLORS}
    }));
    defaultsSegment = getSegment(await getJson(host, '/json/state'), args.seg);
    if (Object.keys(overrides).length) {
      await postJson(host, '/json', {tt: args.tt, seg: Object.assign({id: args.seg}, overrides)});
    }
    return defaultsSegment;
  }

  await postJson(host, '/json', Object.assign(baseState(args), {
    seg: Object.assign({id: args.seg, fx}, overrides)
  }));
  return defaultsSegment;
}

async function printDelta(host, args, fx) {
  const data = await readBaselineFile(args.baselineFile);
  const entry = data.baselines?.[baselineKey(fx, args.seg)];
  if (!entry) {
    throw new Error(`No saved defaults for effect ${fx} segment ${args.seg}. Run without --delta first to save a baseline.`);
  }

  const state = await getJson(host, '/json/state');
  const segment = getSegment(state, args.seg);
  if (segment.fx !== fx) {
    console.warn(`Warning: segment ${args.seg} is currently effect ${segment.fx}, expected ${fx}`);
  }

  const delta = diffSegmentDefaults(entry.defaults, segment);
  console.log(JSON.stringify({seg: delta}));
  console.log(`seg = ${inlineTomlObject(delta)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const host = await resolveHost(args.host);
  const effectInfo = await resolveEffectId(host, args.effect);
  const fx = effectInfo.id;
  if (args.delta) {
    await printDelta(host, args, fx);
    return;
  }

  const defaultsSegment = await applyEffect(host, args, effectInfo);
  if (defaultsSegment) {
    await saveDefaultBaseline(args.baselineFile, {
      fx,
      effect: effectInfo.name,
      segId: args.seg,
      segment: defaultsSegment
    });
  }
  const state = await getJson(host, '/json/state');
  const segment = getSegment(state, args.seg);
  const details = segment ? ` sx=${segment.sx} ix=${segment.ix} pal=${segment.pal} wX=${segment.wX}` : '';
  console.log(`Set segment ${args.seg} to effect ${fx}${details}`);
  if (defaultsSegment) console.log(`Saved defaults to ${args.baselineFile}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
