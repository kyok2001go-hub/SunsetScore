import { fail } from '../dataset/lib/common.mjs';
import { REPLAY_RUNTIME_FILES } from '../replay/replay-runner.mjs';
import { digest } from './policy.mjs';
// Explicit, byte-pinned default-compatible implementations. Every caller must also
// reproduce all original sample scores, ordinals, metrics and saved traces.
const CURRENT_PINS = Object.freeze({
  "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
  "js/config.js": "cabf185bb0946fc9ad968bd1c24fa8b93d8c2567f2c9d7d87f93b34cb2491ecf",
  "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
  "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d"
});
const ORIGINS = Object.freeze([
{
  "engine": "a271e3fd66b84fb3b72ffedb5b849211ebe9d5d8247e3a1a2ceaa18962ccd0db",
  "files": {
    "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
    "js/config.js": "6b762d0fa8cfd6d106b593ba5edd9af5d6caf99f7b5d6f0b544d1339d53abb77",
    "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
    "js/model_config.js": "a406bc1005d21b2371383cd51e1f4e9d3a75e0e638b8c4bf311284d48d918868"
  }
},
  {
    "engine": "89240f01dbc185d1202e28694702ce5c2f86368ff8384372c775656e9db37924",
    "files": {
      "js/engine.js": "8e7cb69d24688aa1fb4cbe6549d0ee2aebb41056a5875c32cbbc4e9505635a9d",
      "js/config.js": "7b7ea9e324ca50eadbcd881448a858615646953aa18cc2e7e329c1662bbcac14",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "ba84a59f1028cc33867479ddcb98925ea4663d07e70554d7ca67a0a2dac0f204"
    }
  },
  {
    "engine": "db7043ef4d58b35fd1b866d3d6b23c4c5e4c26140d35135329b06cb8fc093e15",
    "files": {
      "js/engine.js": "8e7cb69d24688aa1fb4cbe6549d0ee2aebb41056a5875c32cbbc4e9505635a9d",
      "js/config.js": "76725e9e0a1408efff22f4e805a11e40ec5912f5adf7e6a642941ea71f75ad46",
      "js/sky_state.js": "03410f3126c19a12d90ecf4701e60293ed3ff4153dbc51bdbff17a2dcd158bdb",
      "js/model_config.js": "ba84a59f1028cc33867479ddcb98925ea4663d07e70554d7ca67a0a2dac0f204"
    }
  }
]);
export function assertCompatibleEngine(current, expected, { allowDefaultCompatibility = false, reason = 'PRACTICAL_CODE_MISMATCH' } = {}) {
  if (current.engine_sha256 === expected.engine_sha256) return { mode: 'IDENTICAL_ENGINE', old_engine_sha256: expected.engine_sha256, current_engine_sha256: current.engine_sha256 };
  const origin = ORIGINS.find(o => o.engine === expected.engine_sha256);
  if (!allowDefaultCompatibility || !origin || !expected.files ||
      digest(Object.fromEntries(REPLAY_RUNTIME_FILES.map(f => [f, expected.files[f]]))) !== expected.engine_sha256 ||
      digest(Object.fromEntries(REPLAY_RUNTIME_FILES.map(f => [f, current.files[f]]))) !== current.engine_sha256 ||
      REPLAY_RUNTIME_FILES.some(f => CURRENT_PINS[f] ? expected.files[f] !== origin.files[f] || current.files[f] !== CURRENT_PINS[f] : expected.files[f] !== current.files[f])) fail(reason);
  return { mode: 'PINNED_EXPLICIT_FROZEN_CONFIG_COMPATIBLE_MODEL2550_RELEASE', old_engine_sha256: expected.engine_sha256, current_engine_sha256: current.engine_sha256,
    changed_files: Object.fromEntries(Object.keys(CURRENT_PINS).filter(f => origin.files[f] !== CURRENT_PINS[f]).map(f => [f, { old: origin.files[f], current: CURRENT_PINS[f] }])),
    proof_requirement: 'EXPLICIT_HISTORICAL_CONFIG_ONLY; NEW_DEFAULT_IS_CHANGED; EXACT_OLD_SCORES_ORDINALS_METRICS_AND_TRACES_REQUIRED' };
}
