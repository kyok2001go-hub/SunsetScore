import { REPLAY_CLASSES, WIRED_STATUSES, CONSTRAINT_TYPES } from './tuning-policy.mjs';

export const REGISTRY_VERSION = 1;

const DEFAULT_OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3];
const WIDE_OFFSETS = [-0.5, -0.25, 0, 0.25, 0.5];
const SIMPLEX_FACTORS = [0.8, 1.2];

const MIN_SUPPORT = Object.freeze({ events: 5, dates: 2 });

function oat(spec) {
  return Object.freeze({
    unit_category: 'OAT',
    baseline_source: 'TUNING_BASE_CONFIG',
    group_id: null,
    replay_class: 'REPLAY_SAFE',
    wired_status: 'WIRED',
    optimizable: true,
    ablation_supported: false,
    activation_condition: 'always',
    min_support: MIN_SUPPORT,
    trigger_regimes: null,
    integer: false,
    extra_constraint_types: [],
    probe_offsets: DEFAULT_OFFSETS,
    probe_absolute: null,
    ...spec
  });
}

function simplex(spec) {
  return Object.freeze({
    unit_category: 'SIMPLEX',
    baseline_source: 'TUNING_BASE_CONFIG',
    replay_class: 'REPLAY_SAFE',
    wired_status: 'WIRED',
    optimizable: true,
    ablation_supported: false,
    activation_condition: 'always',
    min_support: MIN_SUPPORT,
    trigger_regimes: null,
    extra_constraint_types: [],
    probe_factors: SIMPLEX_FACTORS,
    ...spec
  });
}

/**
 * Diagnostic units carry no probes: they document wiring status for parameters that
 * must not enter formal sensitivity conclusions (plan section 4.4).
 */
function diagnostic(spec) {
  return Object.freeze({
    unit_category: 'DIAGNOSTIC',
    group_id: null,
    baseline_source: 'TUNING_BASE_CONFIG',
    replay_class: 'REPLAY_SAFE',
    optimizable: false,
    ablation_supported: false,
    activation_condition: 'always',
    min_support: MIN_SUPPORT,
    trigger_regimes: null,
    extra_constraint_types: [],
    probe_offsets: [],
    probe_absolute: null,
    ...spec
  });
}

export const UNITS = Object.freeze([
  oat({
    parameter_id: 'high_cloud_center', canonical_path: 'highCloudCenter',
    range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 122, token: 'highCloudCenter' }] }
  }),
  oat({
    parameter_id: 'high_cloud_width', canonical_path: 'highCloudWidth',
    range: [1, 60], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 122, token: 'highCloudWidth' }] }
  }),
  oat({
    parameter_id: 'mid_cloud_center', canonical_path: 'midCloudCenter',
    range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 123, token: 'midCloudCenter' }] }
  }),
  oat({
    parameter_id: 'mid_cloud_width', canonical_path: 'midCloudWidth',
    range: [1, 60], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 123, token: 'midCloudWidth' }] }
  }),
  oat({
    parameter_id: 'aod_center', canonical_path: 'aodCenter', range: [0, 2],
    probe_offsets: WIDE_OFFSETS,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 406, token: 'aodCenter' }] }
  }),
  oat({
    parameter_id: 'aod_width', canonical_path: 'aodWidth', range: [0.01, 1],
    probe_offsets: WIDE_OFFSETS,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 406, token: 'aodWidth' }] }
  }),
  oat({
    parameter_id: 'humidity_center', canonical_path: 'humidityCenter', range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 408, token: 'humidityCenter' }] }
  }),
  oat({
    parameter_id: 'humidity_width', canonical_path: 'humidityWidth', range: [1, 60], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 408, token: 'humidityWidth' }] }
  }),
  oat({
    parameter_id: 'visibility_scale_km', canonical_path: 'visibilityScaleKm', range: [0.5, 40],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 398, token: 'visibilityScaleKm' }] }
  }),
  oat({
    parameter_id: 'atmosphere_quality_base', canonical_path: 'atmosphereQuality.base', range: [0, 1],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 740, token: 'atmosphereQuality' }] }
  }),
  oat({
    parameter_id: 'atmosphere_quality_scale', canonical_path: 'atmosphereQuality.scale', range: [0, 1],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 740, token: 'atmosphereQuality' }] }
  }),
  oat({
    parameter_id: 'hard_gate_horizon_opening_pct', canonical_path: 'hardGate.horizonOpeningPct', range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 725, token: 'hardGate' }] }
  }),
  oat({
    parameter_id: 'hard_gate_visibility_km', canonical_path: 'hardGate.visibilityKm', range: [0, 50],
    probe_absolute: [1, 1.5, 2, 3, 5],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 726, token: 'hardGate' }] }
  }),
  oat({
    parameter_id: 'hard_gate_score_cap', canonical_path: 'hardGate.scoreCap', range: [0, 100], integer: true,
    probe_absolute: [5, 10, 15, 25, 40],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 727, token: 'hardGate' }] }
  }),
  oat({
    parameter_id: 'minimum_weather_weight', canonical_path: 'weatherRegime.minimumWeatherWeight', range: [0, 1],
    probe_absolute: [0, 0.02, 0.05, 0.1, 0.15],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 671, token: 'minimumWeatherWeight' }] }
  }),
  oat({
    parameter_id: 'golden_window_floor', canonical_path: 'goldenWindow.floor', range: [0, 1],
    probe_offsets: WIDE_OFFSETS,
    wiring_evidence: {
      read_at: [
        { file: 'js/prediction_service.js', line: 331, token: 'goldenWindow.floor' },
        { file: 'js/evolution.js', line: 298, token: 'goldenWindow', binding: 'goldenWindow' }
      ]
    }
  }),
  oat({
    parameter_id: 'evolution_sigma0', canonical_path: 'evolution.sigma0', range: [0.5, 40],
    wiring_evidence: { read_at: [{ file: 'js/evolution.js', line: 68, token: 'sigma0' }] }
  }),
  oat({
    parameter_id: 'evolution_sigma_per_min', canonical_path: 'evolution.sigmaPerMin', range: [0.001, 2],
    wiring_evidence: { read_at: [{ file: 'js/evolution.js', line: 68, token: 'sigmaPerMin' }] }
  }),
  oat({
    parameter_id: 'evolution_background_weight', canonical_path: 'evolution.backgroundWeight', range: [0, 1],
    probe_offsets: WIDE_OFFSETS,
    wiring_evidence: { read_at: [{ file: 'js/evolution.js', line: 225, token: 'backgroundWeight' }] }
  }),
  oat({
    parameter_id: 'evolution_open_coverage_threshold', canonical_path: 'evolution.openCoverageThreshold', range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/evolution.js', line: 123, token: 'openCoverageThreshold' }] }
  }),
  oat({
    parameter_id: 'regime_score_clear', canonical_path: 'regimeScore.CLEAR', range: [0, 100], integer: true,
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 532, token: 'regimeScore' }] }
  }),
  oat({
    parameter_id: 'structure_bonus_value', canonical_path: 'spatialEvolution.structure.bonusValue', range: [0, 50],
    probe_absolute: [0, 2, 5, 8, 12],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 389, token: 'bonusValue' }] }
  }),
  oat({
    parameter_id: 'nowcast_analysis_horizon_minutes', canonical_path: 'nowcast.analysisHorizonMinutes', range: [30, 360], integer: true,
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'minute_precip_available',
    probe_absolute: [60, 90, 120, 150, 180],
    wiring_evidence: { read_at: [{ file: 'js/nowcast.js', line: 240, token: 'analysisHorizonMinutes' }] }
  }),
  oat({
    parameter_id: 'rain_clear_stop_within_30', canonical_path: 'nowcast.rainClear.stopWithin30', range: [-100, 100], integer: true,
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'regime_rain_to_clear',
    trigger_regimes: ['RAIN_TO_CLEAR'], probe_offsets: WIDE_OFFSETS,
    wiring_evidence: { read_at: [{ file: 'js/nowcast.js', line: 278, token: 'stopWithin30' }] }
  }),
  oat({
    parameter_id: 'rain_to_clear_min_rain_mm', canonical_path: 'rainToClearMinRainMm', range: [0, 10],
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'regime_rain_to_clear',
    trigger_regimes: ['RAIN_TO_CLEAR'], probe_absolute: [0.1, 0.2, 0.3, 0.5, 0.8],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 498, token: 'rainToClearMinRainMm' }] }
  }),
  oat({
    parameter_id: 'rain_to_clear_golden_window_min', canonical_path: 'rainToClearGoldenWindow.min', range: [0, 120], integer: true,
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'regime_rain_to_clear',
    trigger_regimes: ['RAIN_TO_CLEAR'],
    extra_constraint_types: ['MIN_MAX'],
    pair_constraint: { sibling_path: 'rainToClearGoldenWindow.max', relation: 'LESS_THAN_OR_EQUAL' },
    probe_absolute: [15, 20, 30, 45, 60],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 505, token: 'rainToClearGoldenWindow' }] }
  }),
  oat({
    parameter_id: 'satellite_high_cloud_center', canonical_path: 'nowcast.satellite.highCloudCenter', range: [0, 100], integer: true,
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'satellite_available',
    extra_constraint_types: ['DEPENDENT'], depends_on: { path: 'nowcast.satellite.enabled', equals: true },
    wiring_evidence: { read_at: [{ file: 'js/nowcast.js', line: 640, token: 'highCloudCenter' }] }
  }),
  simplex({
    parameter_id: 'component_weights', group_id: 'component_weights', canonical_path: 'weights',
    members: ['skyCanvas', 'horizon', 'illumination', 'atmosphere', 'weather'],
    wiring_evidence: {
      read_at: [
        { file: 'js/engine.js', line: 667, token: 'weights.skyCanvas' },
        { file: 'js/engine.js', line: 671, token: 'weights.weather' }
      ]
    }
  }),
  simplex({
    parameter_id: 'canvas_weights', group_id: 'canvas_weights', canonical_path: 'canvasWeights',
    members: ['high', 'mid', 'low'],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 382, token: 'canvasWeights' }] }
  }),
  simplex({
    parameter_id: 'atmosphere_weights', group_id: 'atmosphere_weights', canonical_path: 'atmosphereWeights',
    members: ['visibility', 'aod', 'pm25', 'humidity'],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 411, token: 'atmosphereWeights' }] }
  }),
  simplex({
    parameter_id: 'sky_canvas_weights', group_id: 'sky_canvas_weights', canonical_path: 'spatialEvolution.skyCanvasWeights',
    members: ['local', 'bank', 'far', 'structure', 'antiSunset'],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 379, token: 'skyCanvasWeights' }] }
  }),
  simplex({
    parameter_id: 'horizon_distance_weights', group_id: 'horizon_distance_weights', canonical_path: 'horizonDistanceWeights',
    members: ['0', '50', '100', '200', '300'],
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 209, token: 'horizonDistanceWeights' }] }
  }),
  simplex({
    parameter_id: 'nowcast_weights', group_id: 'nowcast_weights', canonical_path: 'nowcast.weights',
    members: ['forecast', 'precip', 'radar', 'satellite'],
    replay_class: 'CONDITIONALLY_REPLAYABLE', activation_condition: 'nowcast_available',
    extra_constraint_types: ['DEPENDENT'], depends_on: { path: 'nowcast.enabled', equals: true },
    wiring_evidence: { read_at: [{ file: 'js/nowcast.js', line: 675, token: 'nowcast.weights' }] }
  }),
  diagnostic({
    parameter_id: 'sky_state_factor_range', canonical_path: 'skyState.factorRange',
    wired_status: 'PARTIALLY_WIRED',
    scan_token: 'factorRange',
    reason_code: 'PARTIALLY_WIRED_EXCLUDED_FROM_FORMAL_SENSITIVITY',
    extra_constraint_types: ['MIN_MAX'],
    wiring_evidence: {
      read_at: [{ file: 'js/sky_state.js', line: 149, token: 'factorRange' }],
      truncation_sites: [
        { file: 'js/prediction_service.js', line: 278, token: '0.65, 1.15' },
        { file: 'tools/replay/replay-runner.mjs', line: 241, token: '0.65, 1.15' }
      ]
    }
  }),
  diagnostic({
    parameter_id: 'viewing_window_peak_offset', canonical_path: 'viewingWindow.peakOffsetMin',
    wired_status: 'OPERATIONAL_ONLY',
    scan_token: 'viewingWindow',
    reason_code: 'DISPLAY_ONLY_NOT_IN_SCORING_PATH',
    wiring_evidence: {
      read_at: [{ file: 'js/engine.js', line: 939, token: 'viewingWindow', outside_scoring_path: true }]
    }
  })
]);

export const ABLATIONS = Object.freeze([
  {
    ablation: 'NO_GOLDEN_WINDOW', ablation_layer: 'RUNNER', optimizable: false,
    mechanism: 'CONFIG_SWITCH', override: { goldenWindow: { enabled: false } },
    canonical_path: 'goldenWindow.enabled',
    wiring_evidence: { read_at: [{ file: 'js/evolution.js', line: 333, token: 'cfg.enabled' }] }
  },
  {
    ablation: 'NO_SKY_EVOLUTION', ablation_layer: 'RUNNER', optimizable: false,
    mechanism: 'CONFIG_RANGE_PIN', override: { skyState: { factorRange: [1, 1] } },
    canonical_path: 'skyState.factorRange',
    wiring_evidence: { read_at: [{ file: 'js/sky_state.js', line: 149, token: 'factorRange' }] }
  },
  {
    ablation: 'NO_STRUCTURE_BONUS', ablation_layer: 'ENGINE', optimizable: false,
    mechanism: 'CONFIG_ZERO', override: { spatialEvolution: { structure: { bonusValue: 0 } } },
    canonical_path: 'spatialEvolution.structure.bonusValue',
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 389, token: 'bonusValue' }] }
  },
  {
    ablation: 'NO_TRANSITION_BONUS', ablation_layer: 'ENGINE', optimizable: false,
    mechanism: 'CONFIG_SWITCH', override: { weatherRegime: { transitionEnabled: false } },
    canonical_path: 'weatherRegime.transitionEnabled',
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 681, token: 'transitionEnabled' }] }
  },
  {
    ablation: 'NO_DYNAMIC_REGIME_WEIGHT', ablation_layer: 'ENGINE', optimizable: false,
    mechanism: 'CONFIG_NEUTRALIZE_MAP', override: { weatherRegime: { weights: 'NEUTRALIZE_TO_ONE' } },
    canonical_path: 'weatherRegime.weights',
    wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 663, token: 'regimeConfig.weights' }] }
  }
]);

export function registryUnit(id) {
  const unit = UNITS.find(item => item.parameter_id === id);
  if (!unit) throw Object.assign(new Error('UNKNOWN_PARAMETER_ID'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'UNKNOWN_PARAMETER_ID' });
  return unit;
}

export function validateRegistryShape() {
  const ids = new Set();
  for (const unit of UNITS) {
    if (!unit.parameter_id || ids.has(unit.parameter_id)) {
      throw Object.assign(new Error('DUPLICATE_PARAMETER_ID'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'DUPLICATE_PARAMETER_ID' });
    }
    ids.add(unit.parameter_id);
    if (!REPLAY_CLASSES.includes(unit.replay_class)) {
      throw Object.assign(new Error('INVALID_REPLAY_CLASS'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'INVALID_REPLAY_CLASS' });
    }
    if (!WIRED_STATUSES.includes(unit.wired_status)) {
      throw Object.assign(new Error('INVALID_WIRED_STATUS'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'INVALID_WIRED_STATUS' });
    }
    const types = unit.unit_category === 'SIMPLEX' ? ['SIMPLEX', ...unit.extra_constraint_types] : ['RANGE', ...unit.extra_constraint_types];
    for (const type of types) {
      if (!CONSTRAINT_TYPES.includes(type)) {
        throw Object.assign(new Error('INVALID_CONSTRAINT_TYPE'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'INVALID_CONSTRAINT_TYPE' });
      }
    }
    if (unit.unit_category === 'DIAGNOSTIC' && unit.optimizable !== false) {
      throw Object.assign(new Error('DIAGNOSTIC_MUST_NOT_BE_OPTIMIZABLE'), { code: 'TUNING_VALIDATION_FAILED', reason_code: 'DIAGNOSTIC_MUST_NOT_BE_OPTIMIZABLE' });
    }
  }
  return true;
}

export function registryDocument() {
  return {
    parameter_registry_version: REGISTRY_VERSION,
    units: UNITS,
    ablations: ABLATIONS
  };
}

export function registrySha256Source() {
  return registryDocument();
}
