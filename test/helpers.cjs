const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');

function createRuntime(extra = {}) {
  const storage = new Map();
  const sandbox = {
    console,
    Date,
    Math,
    Intl,
    JSON,
    Promise,
    Error,
    AbortController,
    AbortSignal,
    URL,
    TextEncoder,
    Uint8Array,
    crypto: global.crypto,
    Response,
    Number,
    String,
    Array,
    Object,
    RegExp,
    setTimeout,
    clearTimeout,
    fetch: global.fetch,
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      key: (index) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; }
    },
    ...extra
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, storage };
}

function load(runtime, files) {
  for (const file of files) {
    const code = readFileSync(join(ROOT, file), 'utf8');
    vm.runInContext(code, runtime.sandbox, { filename: file });
  }
  return runtime.sandbox.SunsetScore;
}

const CORE_FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/data.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js',
  'js/sky_state.js', 'js/evolution.js', 'js/engine.js', 'js/baseline.js'
];

function forecast(values = {}) {
  const times = ['2026-08-26T16:00', '2026-08-26T17:00', '2026-08-26T18:00', '2026-08-26T19:00', '2026-08-26T20:00'];
  const series = (key, fallback) => times.map((_, index) => {
    const value = values[key];
    return Array.isArray(value) ? value[index] : (value == null ? fallback : value);
  });
  return {
    utc_offset_seconds: 0,
    timezone: 'UTC',
    hourly: {
      time: times,
      cloud_cover: series('cloud', 50),
      cloud_cover_low: series('low', 20),
      cloud_cover_mid: series('mid', 40),
      cloud_cover_high: series('high', 55),
      visibility: series('visibility', 18000),
      relative_humidity_2m: series('humidity', 55),
      precipitation: series('precipitation', 0),
      precipitation_probability: series('precipitationProbability', 10),
      wind_speed_10m: series('windSpeed', 15),
      wind_direction_10m: series('windDirection', 270),
      wind_gusts_10m: series('windGusts', 22),
      surface_pressure: series('pressure', 1012),
      wind_speed_850hPa: series('wind850', 25),
      wind_direction_850hPa: series('windDir850', 275),
      wind_speed_700hPa: series('wind700', 35),
      wind_direction_700hPa: series('windDir700', 280),
      wind_speed_500hPa: series('wind500', 55),
      wind_direction_500hPa: series('windDir500', 290)
    }
  };
}

function localSample(fc) {
  return {
    point: {
      key: 'CENTER_0', direction: 'CENTER', azimuth: 0,
      distanceKm: 0, azimuthOffset: 0,
      latitude: 31.23, longitude: 121.47, weight: 1
    },
    forecast: fc
  };
}

module.exports = { createRuntime, load, CORE_FILES, forecast, localSample };
