import { compare } from './common.mjs';
const distribution = values => {
  const counts = new Map();
  for (const value of values) {
    const key = value === null ? '(null)' : String(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => compare(a, b)).map(([value, count]) => ({ value, count }));
};
const summary = values => {
  if (!values.length) return { min: null, max: null, mean: null, median: null };
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { min: sorted[0], max: sorted.at(-1), mean: sorted.reduce((sum, x) => sum + x, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 };
};
export function datasetStatistics(tables, selection) {
  const snapshots = tables.prediction_snapshots, observations = tables.sunset_observations;
  const events = tables.events, replays = tables.replay_index;
  const dates = events.map(x => x.event_date_local).sort(compare);
  return {
    requested_date_range: { from: selection.event_date_from, to: selection.event_date_to },
    actual_date_range: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    counts: { events: events.length, snapshots: snapshots.length, observations: observations.length, replays: replays.length },
    snapshots_per_event: distribution(events.map(x => x.snapshot_count)),
    observations_per_event: distribution(events.map(x => x.observation_count)),
    events_without_observation: events.filter(x => !x.has_observation).length,
    selected_replay_coverage: snapshots.length ? replays.length / snapshots.length : null,
    lead_time_minutes: summary(snapshots.map(x => x.lead_time_minutes)),
    snapshots: Object.fromEntries(['city', 'snapshot_source', 'scheduled_slot', 'model_version'].map(field => [field, distribution(snapshots.map(x => x[field]))])),
    replays: Object.fromEntries(['engine_build_sha', 'config_hash'].map(field => [field, distribution(replays.map(x => x[field]))])),
    observations: Object.fromEntries(['source', 'rating'].map(field => [field, distribution(observations.map(x => x[field]))]))
  };
}
