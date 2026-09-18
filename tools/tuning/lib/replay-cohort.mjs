import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { canonicalJson, compare, fail, safePath } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';

const IDENTITY_FIELDS = ['snapshot_id', 'event_id', 'config_hash', 'engine_build_sha', 'prediction_time_utc'];

function issueCodes(report) {
  return [...(report.comparison_errors || [])].sort().join('|');
}

/**
 * Loads the TRAIN Replay payloads and binds each one to its Snapshot row. The binding uses
 * identity fields carried by the payload itself, so a mismatched or foreign Replay fails
 * instead of silently pairing with the wrong row.
 */
export async function loadReplayCohort({ rows, rawDir, progress = silentProgress }) {
  progress.stage('读取 TRAIN Replay 载荷并绑定身份');
  const cohort = [];
  for (const row of rows) {
    const file = await safePath(path.join(rawDir, row.replay_path));
    let replay;
    try {
      replay = JSON.parse((await readFile(file)).toString('utf8'));
    } catch {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'REPLAY_UNREADABLE', detail: row.snapshot_id });
    }
    if (replay.replay_schema_version !== 1) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_REPLAY_SCHEMA', detail: row.snapshot_id });
    }
    for (const field of IDENTITY_FIELDS) {
      if (replay.identity[field] !== row[field]) {
        fail('TUNING_VALIDATION_FAILED', {
          reason_code: 'REPLAY_IDENTITY_MISMATCH',
          detail: { snapshot_id: row.snapshot_id, field, replay: replay.identity[field], row: row[field] }
        });
      }
    }
    cohort.push({
      ...row,
      replay,
      support: {
        regime_label: row.regime_label,
        has_minute_precip: Boolean(replay.minute_precip && replay.minute_precip.available),
        has_radar: Boolean(replay.radar && replay.radar.available),
        has_satellite: Boolean(replay.satellite && replay.satellite.available),
        has_nowcast: Boolean((replay.minute_precip && replay.minute_precip.available) ||
          (replay.radar && replay.radar.available) || (replay.satellite && replay.satellite.available))
      }
    });
  }
  return cohort.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
}

/** Replay Reference Control: replay with the historical config and compare to the Snapshot. */
export async function verifyReplayParity({ cohort, runReplay, progress = silentProgress }) {
  progress.stage('Replay Reference Parity');
  const rows = [];
  for (const row of cohort) {
    const report = await runReplay(row.replay, { reference: row });
    const components = Object.values(report.deltas.components || {}).filter(value => Number.isFinite(value));
    rows.push({
      snapshot_id: row.snapshot_id,
      event_id: row.event_id,
      split: 'TRAIN',
      event_date_local: row.event_date_local,
      city: row.city,
      lead_time_bucket: row.lead_time_bucket,
      engine_build_sha: row.engine_build_sha,
      config_hash: row.config_hash,
      pass: report.pass === true,
      actual_score: report.actual.score,
      reference_score: report.reference.score,
      score_delta: report.actual.score - report.reference.score,
      max_component_abs_delta: components.length ? Math.max(...components.map(Math.abs)) : null,
      issue_codes: issueCodes(report) || null
    });
  }
  const passed = rows.filter(row => row.pass).length;
  return {
    rows,
    summary: {
      sample_count: rows.length,
      pass_count: passed,
      fail_count: rows.length - passed,
      replay_usable_rate: rows.length ? passed / rows.length : 0
    }
  };
}

export function supportFor(unit, row) {
  switch (unit.activation_condition) {
    case 'minute_precip_available': return row.support.has_minute_precip;
    case 'satellite_available': return row.support.has_satellite;
    case 'nowcast_available': return row.support.has_nowcast;
    case 'regime_rain_to_clear': return row.support.regime_label === 'RAIN_TO_CLEAR';
    default: return true;
  }
}

export function supportMetrics(unit, cohort) {
  const supported = cohort.filter(row => supportFor(unit, row));
  return {
    support_samples: supported.length,
    support_events: new Set(supported.map(row => row.event_id)).size,
    support_dates: new Set(supported.map(row => row.event_date_local)).size
  };
}

export function parityDigest(rows) {
  return canonicalJson(rows.map(row => [row.snapshot_id, row.pass, row.score_delta]));
}
