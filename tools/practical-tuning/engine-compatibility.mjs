import { fail } from '../dataset/lib/common.mjs';
import { REPLAY_RUNTIME_FILES } from '../replay/replay-runner.mjs';
import { digest } from './policy.mjs';
// Explicit, byte-pinned default-compatible implementations. Every caller must also
// reproduce all original sample scores, ordinals, metrics and saved traces.
// V2.5.5.1 changes only js/config.js (skyState.factorRange and version identity) on top of V2.5.5.0.
// V2.5.5.2 changes js/config.js and js/evolution.js (golden-window reference, open thresholds, grade lines); with the
// reference absent from an explicit historical config the golden-window factor is computed exactly as before.
// V2.5.5.4 changes js/engine.js (corridor-centre azimuth fix behind spatialField.centerAzimuthOffset); with the key absent from an
// explicit historical config every engine value is computed exactly as before.
// V2.5.5.5 changes js/engine.js again (aodResponse switch); with the key absent the AOD score is the original Gaussian.
// V2.5.5.6 changes js/evolution.js (golden-window cloud/rain split behind evolution.cloudSignal); with the key absent the factor is unchanged.
// V2.5.5.4 release changes js/config.js (version 2.5.5.4 / app2554, spatialField.centerAzimuthOffset 0); explicit historical configs carry their own values.
// V2.5.5.7 changes js/config.js again (app version 2.5.5.7 / app2557 only; model and scoring configuration unchanged).
// V2.5.5.8 changes js/config.js again (app version 2.5.5.8 / app2558 only; model and scoring configuration unchanged).
const CURRENT_PINS = Object.freeze({
  "js/engine.js": "183ce80e953d6f1a4bca2285647f7feb4b08620085d8596785e9542840c70f73",
  "js/config.js": "466197d5dbd77ee68761270db1b4ccfe04ed26da7a72415b2560bc9ffad3c68d",
  "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
  "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
  "js/evolution.js": "11a2f42045f4f6e12c3ac2d0ddda37c9db6c1545d4693bb52cd37b76ab8ef258"
});
const ORIGINS = Object.freeze([
{
  "engine": "9eaa815a28f29e6674af2e6db7b9d7d379fafa937da6ff70c6d3949a9cb48891",
  "files": {
    "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
    "js/config.js": "cabf185bb0946fc9ad968bd1c24fa8b93d8c2567f2c9d7d87f93b34cb2491ecf",
    "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
    "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
    "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
  }
},
{
  "engine": "a271e3fd66b84fb3b72ffedb5b849211ebe9d5d8247e3a1a2ceaa18962ccd0db",
  "files": {
    "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
    "js/config.js": "6b762d0fa8cfd6d106b593ba5edd9af5d6caf99f7b5d6f0b544d1339d53abb77",
    "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
    "js/model_config.js": "a406bc1005d21b2371383cd51e1f4e9d3a75e0e638b8c4bf311284d48d918868",
    "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
  }
},
  {
    "engine": "89240f01dbc185d1202e28694702ce5c2f86368ff8384372c775656e9db37924",
    "files": {
      "js/engine.js": "8e7cb69d24688aa1fb4cbe6549d0ee2aebb41056a5875c32cbbc4e9505635a9d",
      "js/config.js": "7b7ea9e324ca50eadbcd881448a858615646953aa18cc2e7e329c1662bbcac14",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "ba84a59f1028cc33867479ddcb98925ea4663d07e70554d7ca67a0a2dac0f204",
    "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
    }
  },
  {
    "engine": "db7043ef4d58b35fd1b866d3d6b23c4c5e4c26140d35135329b06cb8fc093e15",
    "files": {
      "js/engine.js": "8e7cb69d24688aa1fb4cbe6549d0ee2aebb41056a5875c32cbbc4e9505635a9d",
      "js/config.js": "76725e9e0a1408efff22f4e805a11e40ec5912f5adf7e6a642941ea71f75ad46",
      "js/sky_state.js": "03410f3126c19a12d90ecf4701e60293ed3ff4153dbc51bdbff17a2dcd158bdb",
      "js/model_config.js": "ba84a59f1028cc33867479ddcb98925ea4663d07e70554d7ca67a0a2dac0f204",
    "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
    }
  },
  {
    "engine": "7caf202bf41202ad08556b98a284aca65bfab3bef1d42d040eb980e7d4defc7b",
    "files": {
      "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
      "js/config.js": "2f76204d03baa9b003d148a92cc371b21f6b49b011ac7d52497369ce10cb2419",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
    "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
    }
  },
  {
    "engine": "f67d4fbca65e7d882b6fe1ea890f3ce5aeb03ce9e41cbb242f4e731e1790cedd",
    "files": {
      "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
      "js/config.js": "0b02767059e93cd3a9ee6b5461d4fd6ae1b9b98b7fa8ee197e9e90e1e94e38c1",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "690eb87afe8743d016b99dbd18d213bb2008d42f9bdd138fa0caa72b74cb89bc"
    }
  },
  // V2.5.5.2 release line (e.g. Policy 9 P0 run practical_tuning_v9_561f773d7e43a9045dc3); differs from the current pins only in js/engine.js.
  {
    "engine": "8e20f02997b03ae73ea3febd8e3a61a92c637834b4de74efa1be8ff06e9fcb0a",
    "files": {
      "js/engine.js": "d8515566354bf71ef5898258a9aa07027120ff5024c833ba42f3499e9a110271",
      "js/config.js": "77fc4265f54df8445097999295ffc097955dfd75713f72529c6c2c3d3aa7b531",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "285a3cf19105b41f5bc1d1d12eb6124c615e57705fd49700a0b195e6ca833b9c"
    }
  },
  // V2.5.5.4 working tree (e.g. Policy 10 run practical_tuning_v10_029b2a3afcd389326426); differs from the current pins only in js/engine.js.
  {
    "engine": "8338a588d81b513728a3f40606e0900a628e60372becf4851fdb767eb19fd219",
    "files": {
      "js/engine.js": "5c105d131cbf19d7b761b07eef608c64b7f156a340187f6778c9fec5f1002226",
      "js/config.js": "77fc4265f54df8445097999295ffc097955dfd75713f72529c6c2c3d3aa7b531",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "285a3cf19105b41f5bc1d1d12eb6124c615e57705fd49700a0b195e6ca833b9c"
    }
  },
  // V2.5.5.5 working tree (e.g. Policy 11 run practical_tuning_v11_81d6faf13f3e42fe645d); differs from the current pins only in js/evolution.js.
  {
    "engine": "8ffaa8dc28ec76d59703910d31d74aeced3685492273d723147180b1bd7d1212",
    "files": {
      "js/engine.js": "183ce80e953d6f1a4bca2285647f7feb4b08620085d8596785e9542840c70f73",
      "js/config.js": "77fc4265f54df8445097999295ffc097955dfd75713f72529c6c2c3d3aa7b531",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "285a3cf19105b41f5bc1d1d12eb6124c615e57705fd49700a0b195e6ca833b9c"
    }
  },
  // V2.5.5.6 working tree before the V2.5.5.4 release (e.g. Policy 12 run practical_tuning_v12_f307106bf58943ec80e5); differs from the current pins only in js/config.js.
  {
    "engine": "8a10d193fb649a873ef01a72fb861fc77e7f928f31d4109c27fed26312aa5937",
    "files": {
      "js/engine.js": "183ce80e953d6f1a4bca2285647f7feb4b08620085d8596785e9542840c70f73",
      "js/config.js": "77fc4265f54df8445097999295ffc097955dfd75713f72529c6c2c3d3aa7b531",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "11a2f42045f4f6e12c3ac2d0ddda37c9db6c1545d4693bb52cd37b76ab8ef258"
    }
  },
  // V2.5.5.4 release (commit a0dfa99); differs from the current pins only in js/config.js.
  {
    "engine": "1eceb99859727857eae08db693dc5d15922a56839f81ef335fd09abc0efec72f",
    "files": {
      "js/engine.js": "183ce80e953d6f1a4bca2285647f7feb4b08620085d8596785e9542840c70f73",
      "js/config.js": "531941d184569904e7c717826e05a45bc94b644d1d5e9c704f9d7af49f2bd5d3",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "11a2f42045f4f6e12c3ac2d0ddda37c9db6c1545d4693bb52cd37b76ab8ef258"
    }
  },
  // V2.5.5.7 release (bypass capture V1); differs from the current pins only in js/config.js.
  {
    "engine": "9ef8009f5238856d91833bc0c7b2d572291104ec79c7a8efdae2f2261f0b5446",
    "files": {
      "js/engine.js": "183ce80e953d6f1a4bca2285647f7feb4b08620085d8596785e9542840c70f73",
      "js/config.js": "d45accc7350fb64d893b4f2f93555f5e2053986828824d7e19737cca7aa69e5d",
      "js/sky_state.js": "7092b64a78cfadf15b7135f10180e5eeb38a97f179f81441f4550c83f7479add",
      "js/model_config.js": "c28b591d7c90c39e5461a3f1525a7dfa35044b7eb8a629c72c96c806960fea7d",
      "js/evolution.js": "11a2f42045f4f6e12c3ac2d0ddda37c9db6c1545d4693bb52cd37b76ab8ef258"
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
