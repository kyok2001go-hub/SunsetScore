import { compare } from '../../dataset/lib/common.mjs';

/** Closest pre-sunset successful Snapshot per Event; ties match Evaluation V2. */
export function closestPreSunset(rows) {
  const chosen = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.lead_time_minutes) || row.lead_time_minutes < 0 ||
        !Number.isInteger(row.prediction_time_epoch)) continue;
    const prior = chosen.get(row.event_id);
    if (!prior || row.lead_time_minutes < prior.lead_time_minutes ||
        (row.lead_time_minutes === prior.lead_time_minutes &&
          (row.prediction_time_epoch > prior.prediction_time_epoch ||
            (row.prediction_time_epoch === prior.prediction_time_epoch &&
              compare(row.snapshot_id, prior.snapshot_id) < 0)))) chosen.set(row.event_id, row);
  }
  return [...chosen.values()].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
}
