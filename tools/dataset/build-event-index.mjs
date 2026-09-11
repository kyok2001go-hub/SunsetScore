import { EVENT_OFFLINE_FIELDS, datasetSchema, projectRow } from './dataset-schema.mjs';
import { compare } from './lib/common.mjs';

export function buildEventIndex(snapshots, observations, replays) {
  const groups = new Map();
  for (const row of snapshots) {
    if (!groups.has(row.event_id)) groups.set(row.event_id, []);
    groups.get(row.event_id).push(row);
  }
  const count = rows => {
    const map = new Map();
    for (const row of rows) map.set(row.event_id, (map.get(row.event_id) || 0) + 1);
    return map;
  };
  const obs = count(observations), replay = count(replays);
  return [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([id, rows]) => {
    rows.sort((a, b) => a.prediction_time_epoch - b.prediction_time_epoch || compare(a.id, b.id));
    const first = rows[0], last = rows.at(-1);
    const times = rows.map(x => x.lead_time_minutes);
    const event = { ...Object.fromEntries(EVENT_OFFLINE_FIELDS.slice(0, 12).map(name => [name, first[name]])),
      snapshot_count: rows.length, observation_count: obs.get(id) || 0, replay_count: replay.get(id) || 0,
      first_prediction_time_utc: first.prediction_time_utc, last_prediction_time_utc: last.prediction_time_utc,
      max_lead_time_minutes: times.reduce((a, b) => Math.max(a, b), -Infinity),
      min_lead_time_minutes: times.reduce((a, b) => Math.min(a, b), Infinity),
      has_snapshot: true, has_observation: (obs.get(id) || 0) > 0, has_replay: (replay.get(id) || 0) > 0 };
    return projectRow(event, datasetSchema().tables.events);
  });
}
