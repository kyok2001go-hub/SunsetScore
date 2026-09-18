import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { canonicalJson, hash, fail } from '../../dataset/lib/common.mjs';
import { APP_ROOT } from './engine-runtime.mjs';

const ALIASED_NAMESPACES = Object.freeze([
  ['version', 'version'], ['sampling', 'sampling'], ['nowcast', 'nowcast'], ['cloudField', 'cloudField'],
  ['wind', 'wind'], ['skyState', 'skyState'], ['evolution', 'evolution'], ['goldenWindow', 'goldenWindow'],
  ['network', 'network'], ['api', 'endpoints'], ['cache', 'cachePolicy']
]);

/** Loads the production config exactly as the browser does, then snapshots it. */
export async function loadFrozenBaseConfig(root = APP_ROOT) {
  const existing = globalThis.SunsetScore;
  if (!existing || !existing.modelConfig) {
    // Never clear the shared global: the Replay runtime owns it and rebuilds it on its own
    // dedicated module instance, so re-importing here would only produce a cached no-op.
    await import(pathToFileURL(path.join(root, 'js/config.js')).href);
    await import(pathToFileURL(path.join(root, 'js/model_config.js')).href);
  }
  const modelConfig = globalThis.SunsetScore && globalThis.SunsetScore.modelConfig;
  if (!modelConfig || !modelConfig.scoring) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'BASE_CONFIG_UNAVAILABLE' });
  }
  // The config root is SS.config, which production exposes as modelConfig.scoring.
  const config = JSON.parse(canonicalJson(modelConfig.scoring));
  return {
    config,
    sha256: hash(canonicalJson(config)),
    model_config_keys: Object.keys(modelConfig),
    namespaces: Object.keys(config).sort()
  };
}

/**
 * Rebuilds the modelConfig shape from js/model_config.js so a Tuning Base Config
 * keeps production aliasing: `modelConfig.scoring === config` and each top-level
 * namespace points at the very same nested object.
 */
export function buildModelConfig(config) {
  return {
    version: config.version,
    scoring: config,
    api: config.endpoints,
    cache: config.cachePolicy,
    sampling: config.sampling,
    nowcast: config.nowcast,
    cloudField: config.cloudField,
    wind: config.wind,
    skyState: config.skyState,
    evolution: config.evolution,
    goldenWindow: config.goldenWindow,
    network: config.network
  };
}

export function cloneConfig(config) {
  return JSON.parse(canonicalJson(config));
}

export function resolvePath(root, dottedPath) {
  const segments = String(dottedPath).split('.');
  let node = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || !(segment in node)) return { exists: false, value: undefined };
    node = node[segment];
  }
  return { exists: true, value: node };
}

export function writePath(root, dottedPath, value) {
  const segments = String(dottedPath).split('.');
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    if (node[segment] === null || typeof node[segment] !== 'object') node[segment] = {};
    node = node[segment];
  }
  node[segments[segments.length - 1]] = value;
  return root;
}

/** Applies one registry override on top of a cloned config. */
export function applyUnitOverride(config, unit, probe) {
  const next = cloneConfig(config);
  if (unit.unit_category === 'SIMPLEX') {
    const base = resolvePath(next, unit.canonical_path).value;
    const members = unit.members;
    const original = members.map(name => Number(base[name]));
    const sum = original.reduce((a, b) => a + b, 0);
    const targetIndex = members.indexOf(probe.member);
    if (targetIndex === -1) fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNKNOWN_SIMPLEX_MEMBER' });
    const others = original.filter((_, index) => index !== targetIndex);
    const othersSum = others.reduce((a, b) => a + b, 0);
    const remaining = 1 - probe.value;
    // Remaining members keep their relative proportions, per plan section 5.
    members.forEach((name, index) => {
      base[name] = index === targetIndex
        ? probe.value
        : (othersSum > 0 ? remaining * (original[index] / othersSum) : remaining / (members.length - 1));
      base[name] = Number(base[name].toFixed(12));
    });
    const installed = members.map(name => Number(base[name]));
    const installedSum = installed.reduce((a, b) => a + b, 0);
    if (Math.abs(installedSum - sum) > 1e-9) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SIMPLEX_NORMALIZATION_FAILED' });
    }
    return { config: next, composition: Object.fromEntries(members.map(name => [name, base[name]])) };
  }
  writePath(next, unit.canonical_path, probe.value);
  return { config: next, composition: null };
}

const NEUTRALIZE = 'NEUTRALIZE_TO_ONE';

function neutralize(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? neutralize(value)
      : (typeof value === 'number' ? 1 : value);
  }
  return out;
}

export function applyAblationOverride(config, ablation) {
  const next = cloneConfig(config);
  const spec = ablation.override;
  for (const [namespace, body] of Object.entries(spec)) {
    for (const [key, value] of Object.entries(body)) {
      if (value === NEUTRALIZE) next[namespace][key] = neutralize(next[namespace][key]);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        next[namespace][key] = { ...(next[namespace][key] || {}), ...value };
      } else next[namespace][key] = value;
    }
  }
  return next;
}

/**
 * Declared alias rule: a top-level namespace and its `scoring.<name>` twin must be the
 * same object in production, so an experiment config must preserve that identity.
 */
export function verifyAliasIdentity(modelConfig) {
  const issues = [];
  for (const [top, nested] of ALIASED_NAMESPACES) {
    const outer = modelConfig[top];
    const inner = modelConfig.scoring ? modelConfig.scoring[nested] : undefined;
    if (outer === undefined || inner === undefined) continue;
    if (outer !== inner) issues.push({ namespace: top, nested_path: 'scoring.' + nested, issue: 'ALIAS_IDENTITY_BROKEN' });
  }
  return { ok: issues.length === 0, aliased_namespaces: ALIASED_NAMESPACES.map(([top]) => top), issues };
}

export function baseConfigDocument(loaded) {
  return {
    tuning_base_config_sha256: loaded.sha256,
    source: 'js/config.js + js/model_config.js',
    namespaces: loaded.namespaces,
    model_config_keys: loaded.model_config_keys,
    config: loaded.config
  };
}
