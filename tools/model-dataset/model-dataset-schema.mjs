// Frozen Raw V1 columns: intentionally materialized, never expanded from a runtime upstream schema.
import { POLICY } from './model-dataset-policy.mjs';
export const RAW_FIELDS = [
  {
    "name": "snapshot_id",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original database row identifier",
    "role": "identifier",
    "prediction_feature_allowed": false
  },
  {
    "name": "idempotency_key",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Snapshot ingestion deduplication identity",
    "role": "identifier",
    "prediction_feature_allowed": false
  },
  {
    "name": "event_id",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Sunset event identity derived from location key and local date",
    "role": "identifier",
    "prediction_feature_allowed": false
  },
  {
    "name": "event_date_local",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Calendar date of sunset in the location timezone",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "location_key",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Provider location identity, or rounded WGS84 coordinates and timezone",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "city",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original city display name; not a unique event identity",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "country",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original country display value",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "admin1",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original first-level administrative area",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "latitude",
    "type": "number",
    "nullable": false,
    "unit": "degree",
    "range": [
      -90,
      90
    ],
    "enum": null,
    "description": "WGS84 latitude",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "longitude",
    "type": "number",
    "nullable": false,
    "unit": "degree",
    "range": [
      -180,
      180
    ],
    "enum": null,
    "description": "WGS84 longitude",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "location_source",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Location identity provider namespace",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "location_id",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Provider location identifier",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "timezone",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Location IANA timezone identifier",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "sunset_time_utc",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Sunset instant in UTC",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "sunset_time_local",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original display string; not an ordering key",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "sunset_azimuth",
    "type": "number",
    "nullable": true,
    "unit": "degree",
    "range": [
      0,
      360
    ],
    "enum": null,
    "description": "Sunset bearing clockwise from north",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "twilight_minutes",
    "type": "integer",
    "nullable": true,
    "unit": "minute",
    "range": [
      0,
      240
    ],
    "enum": null,
    "description": "Civil twilight duration",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "best_viewing_window",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original recommended viewing-window display text",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "query_id",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Prediction query identifier",
    "role": "identifier",
    "prediction_feature_allowed": false
  },
  {
    "name": "prediction_time_utc",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Prediction instant in UTC",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "prediction_time_epoch",
    "type": "integer",
    "nullable": false,
    "unit": "ms",
    "range": [
      0,
      9007199254740991
    ],
    "enum": null,
    "description": "Prediction instant as UTC epoch milliseconds",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "submitted_at_utc",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Application-server submission timestamp in UTC",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "submitted_at_epoch",
    "type": "integer",
    "nullable": false,
    "unit": "ms",
    "range": [
      0,
      9007199254740991
    ],
    "enum": null,
    "description": "Application-server submission timestamp in epoch milliseconds, not a commit sequence",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "snapshot_source",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": [
      "github_schedule",
      "github_manual",
      "user_feedback"
    ],
    "description": "Original snapshot collection source",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "scheduled_slot",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Four-character business HHMM, preserving leading zeros",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "app_version",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Application version at prediction",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "model_version",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Model version at prediction",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "schema_version",
    "type": "integer",
    "nullable": false,
    "unit": null,
    "range": [
      1,
      1000
    ],
    "enum": null,
    "description": "Overall prediction result schema version",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "dataset_schema_version",
    "type": "integer",
    "nullable": false,
    "unit": null,
    "range": [
      1,
      1000
    ],
    "enum": null,
    "description": "Online event dataset contract version of this row",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "asset_revision",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Application static-asset revision at prediction",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "predicted_score",
    "type": "integer",
    "nullable": false,
    "unit": "score point",
    "range": [
      0,
      100
    ],
    "enum": null,
    "description": "Final viewing-quality score, not a calibrated occurrence probability",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "predicted_level",
    "type": "string",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original final prediction level label",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "baseline_score",
    "type": "integer",
    "nullable": true,
    "unit": "score point",
    "range": [
      0,
      100
    ],
    "enum": null,
    "description": "Baseline comparator score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "baseline_level",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Original baseline comparator level label",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "regime_label",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Weather-regime label",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "regime_strength",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Weather-regime intensity",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "sky_evolution_state",
    "type": "string",
    "nullable": true,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "All-day sky evolution state",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "sky_evolution_factor",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      5
    ],
    "enum": null,
    "description": "All-day sky score multiplier",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "gw_factor",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      5
    ],
    "enum": null,
    "description": "Golden-window score multiplier; missing remains null",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "comp_sky_canvas",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Sky canvas component score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "comp_horizon",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Horizon clarity component score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "comp_illumination",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Cloud illumination component score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "comp_atmosphere",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Atmospheric quality component score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "comp_weather",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Weather stability component score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "cloud_cover_total",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Local total cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "cloud_cover_low",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Local low-level cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "cloud_cover_mid",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Local middle-level cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "cloud_cover_high",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Local high-level cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "corridor_cloud_mid",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Sunset corridor mean middle-level cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "corridor_cloud_high",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Sunset corridor mean high-level cloud cover",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "anti_sunset_score",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Opposite-sunset reflection diagnostic score",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "spatial_variance",
    "type": "number",
    "nullable": true,
    "unit": "percentage point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Cloud-cover standard deviation in percentage points",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "cloud_continuity",
    "type": "number",
    "nullable": true,
    "unit": "score point",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Sunset corridor cloud continuity score",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "aod",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Aerosol optical depth",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "pm25",
    "type": "number",
    "nullable": true,
    "unit": "µg/m³",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Fine particulate concentration",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "humidity",
    "type": "number",
    "nullable": true,
    "unit": "percent",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Relative humidity at sunset",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "surface_pressure",
    "type": "number",
    "nullable": true,
    "unit": "hPa",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Surface air pressure",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "visibility_km",
    "type": "number",
    "nullable": true,
    "unit": "km",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Horizontal visibility",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "precipitation",
    "type": "number",
    "nullable": true,
    "unit": "mm",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "Precipitation amount",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_850_speed",
    "type": "number",
    "nullable": true,
    "unit": "km/h",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "850 hPa NWP wind speed",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_850_dir",
    "type": "number",
    "nullable": true,
    "unit": "degree",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "850 hPa NWP wind direction clockwise from north",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_700_speed",
    "type": "number",
    "nullable": true,
    "unit": "km/h",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "700 hPa NWP wind speed",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_700_dir",
    "type": "number",
    "nullable": true,
    "unit": "degree",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "700 hPa NWP wind direction clockwise from north",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_500_speed",
    "type": "number",
    "nullable": true,
    "unit": "km/h",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "500 hPa NWP wind speed",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "layer_wind_500_dir",
    "type": "number",
    "nullable": true,
    "unit": "degree",
    "range": [
      -1000000,
      1000000
    ],
    "enum": null,
    "description": "500 hPa NWP wind direction clockwise from north",
    "role": "feature",
    "prediction_feature_allowed": true
  },
  {
    "name": "is_real_sounding",
    "type": "boolean",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Legacy name: pressure-level NWP winds, not balloon observations",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "open_prob_30m",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Golden-window corridor opening probability at +30m",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "open_prob_60m",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Golden-window corridor opening probability at +60m",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "open_prob_120m",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Golden-window corridor opening probability at +120m",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "arrival_risk_30m",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Upstream cloud arrival risk at +30m",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "arrival_risk_60m",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Upstream cloud arrival risk at +60m",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "tile_radar_available",
    "type": "boolean",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Radar analysis availability, not whether used in score fusion",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "tile_sat_available",
    "type": "boolean",
    "nullable": false,
    "unit": null,
    "range": null,
    "enum": null,
    "description": "Satellite analysis availability, not whether used in score fusion",
    "role": "context",
    "prediction_feature_allowed": false
  },
  {
    "name": "dyn_weight_canvas",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Dynamic score weight for canvas",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "dyn_weight_horizon",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Dynamic score weight for horizon",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "dyn_weight_illum",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Dynamic score weight for illum",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "dyn_weight_atmo",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Dynamic score weight for atmo",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "dyn_weight_weather",
    "type": "number",
    "nullable": true,
    "unit": "dimensionless",
    "range": [
      0,
      1
    ],
    "enum": null,
    "description": "Dynamic score weight for weather",
    "role": "baseline_output",
    "prediction_feature_allowed": false
  },
  {
    "name": "lead_time_minutes",
    "type": "number",
    "nullable": false,
    "unit": "minute",
    "range": null,
    "enum": null,
    "description": "UTC sunset minus prediction time, in minutes; negative after sunset",
    "role": "context",
    "prediction_feature_allowed": false
  }
];
const field = (name, type = 'string', nullable = false, range = null, values = null, role = 'context', subrole) =>
  ({ name, type, nullable, range, enum: values, unit: null, role, prediction_feature_allowed: false, ...(subrole ? { subrole } : {}) });
const gt = [field('gt_label', 'string', true, null, POLICY.labels, 'target'), field('gt_ordinal', 'integer', true, [0, 4], null, 'target'),
  field('gt_confidence', 'number', false, [0, 1], null, 'weight'), field('gt_status', 'string', false, null, POLICY.statuses, 'context', 'target_metadata')];
const eligibilityField = field('eligibility', 'string', false, null, POLICY.eligibility, 'context', 'selection_metadata');
const splitField = field('split', 'string', true, null, POLICY.splits, 'split');
const exclusionField = field('exclusion_reason', 'string', true, null, POLICY.exclusion_reasons, 'context', 'selection_metadata');
export const SAMPLE_FIELDS_V1 = [...RAW_FIELDS, field('lead_time_bucket', 'string', false, null, POLICY.lead_buckets),
  ...['engine_build_sha', 'config_hash', 'replay_path'].map(n => field(n, 'string', false, null, null, 'replay_reference')),
  ...gt, eligibilityField, splitField, field('gt_weight', 'number', false, [0, 1], null, 'weight'),
  field('event_normalized_weight', 'number', false, [0, 1], null, 'weight'),
  field('diagnostic_reason', 'string', true, null, POLICY.diagnostic_reasons, 'context', 'selection_metadata'), exclusionField];
export const EVENT_FIELDS_V1 = [field('event_id', 'string', false, null, null, 'identifier'), field('event_date_local'), field('city'), ...gt,
  ...['primary_snapshot_count', 'diagnostic_snapshot_count', 'excluded_snapshot_count'].map(n => field(n, 'integer', false, [0, Number.MAX_SAFE_INTEGER])),
  eligibilityField, exclusionField, splitField];
export const ERROR_FIELDS = [field('severity', 'string', false, null, ['ERROR', 'WARNING', 'INFO']), field('entity_type'),
  field('entity_id', 'string', true), field('event_id', 'string', true), field('error_code')];
export const SCHEMA_V1 = { model_dataset_schema_version: 1,
  roles: ['identifier', 'context', 'feature', 'baseline_output', 'target', 'weight', 'split', 'replay_reference'],
  csv: { encoding: 'UTF-8 BOM', record_separator: 'CRLF', final_record_separator: true, null: 'unquoted empty', empty_string: 'quoted empty', boolean: '0/1' },
  tables: { samples: SAMPLE_FIELDS_V1, event_splits: EVENT_FIELDS_V1, errors: ERROR_FIELDS } };

const basis = field('gt_basis', 'string', false, null, POLICY.basis_order, 'context', 'target_metadata');
const addBasis = fields => fields.flatMap(f => f.name === 'gt_status' ? [f, basis] : [f]);
export const SAMPLE_FIELDS = addBasis(SAMPLE_FIELDS_V1);
export const EVENT_FIELDS = addBasis(EVENT_FIELDS_V1);
export const SCHEMA = { ...SCHEMA_V1, model_dataset_schema_version: 2, tables: { ...SCHEMA_V1.tables, samples: SAMPLE_FIELDS, event_splits: EVENT_FIELDS } };
export function modelSchema(version) {
  if (version === 1) return SCHEMA_V1;
  if (version === 2) return SCHEMA;
  throw new Error('UNSUPPORTED_MODEL_DATASET_SCHEMA');
}
