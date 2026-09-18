/**
 * Known `cfg` bindings in the scoring path. Each wiring anchor declares the binding that
 * applies at its own line, because one file can bind different namespaces in different
 * functions: js/evolution.js binds `evolution` in most helpers but `goldenWindow` for the
 * golden-window maths, and js/prediction_service.js reads `SS.modelConfig` directly.
 *
 * `scoring` and `root` mean "reached from the config root", which every canonical path
 * satisfies. Any other value must equal the parameter's leading namespace.
 */
export const KNOWN_BINDINGS = Object.freeze({
  scoring: 'SS.modelConfig.scoring',
  root: 'SS.modelConfig.<namespace>',
  evolution: 'SS.modelConfig.evolution',
  goldenWindow: 'SS.modelConfig.goldenWindow',
  skyState: 'SS.modelConfig.skyState',
  cloudField: 'SS.modelConfig.cloudField',
  wind: 'SS.modelConfig.wind',
  nowcast: 'SS.modelConfig.nowcast',
  sampling: 'SS.modelConfig.sampling'
});

export function bindingIsNamespaceScoped(binding) {
  return Boolean(binding) && binding !== 'scoring' && binding !== 'root';
}

/** Default binding per scoring file; an anchor overrides it where the file differs. */
export const DEFAULT_ANCHOR_BINDINGS = Object.freeze({
  'js/engine.js': 'scoring',
  'js/evolution.js': 'evolution',
  'js/sky_state.js': 'skyState',
  'js/cloud_field.js': 'cloudField',
  'js/cloud_motion.js': 'wind',
  'js/nowcast.js': 'nowcast',
  'js/baseline.js': 'scoring',
  'js/sampling.js': 'sampling',
  'js/prediction_service.js': 'root',
  'tools/replay/replay-runner.mjs': 'root'
});
