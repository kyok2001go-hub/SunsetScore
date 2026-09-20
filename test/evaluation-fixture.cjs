const path = require('node:path');
const fs = require('node:fs/promises');
const { gzipSync } = require('node:zlib');
const { database } = require('./d1-helper.cjs');

const date = i => `2026-09-${String(i + 1).padStart(2, '0')}`;

async function createSyntheticPipeline(tempRoot, options = {}) {
  const { sqlite } = database();
  const common = await import('../tools/dataset/lib/common.mjs');
  const exporter = await import('../tools/dataset/export-dataset.mjs');
  const parser = await import('../tools/dataset/lib/selection.mjs');
  const { buildGroundTruth } = await import('../tools/ground-truth/build-ground-truth.mjs');
  const { buildModelDataset } = await import('../tools/model-dataset/build-model-dataset.mjs');
  const datasetSchemaModule = await import('../tools/dataset/dataset-schema.mjs');
  const replayFixture = await import('../tools/replay/replay-fixture.mjs');

  const objects = new Map();
  const insert = (table, row) => {
    const keys = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => row[k]));
  };

  // Default counts [25, 8, 8] gives 41 events across 3 dates (TRAIN 25, VAL 8, TEST 8)
  const counts = options.counts || [25, 8, 8];
  let totalIdx = 0;

  for (let d = 0; d < counts.length; d++) {
    const dt = date(d);
    for (let n = 0; n < counts[d]; n++) {
      const i = totalIdx++;
      const location_id = String(101000000 + i);
      const location_key = `qweather:${location_id}`;
      const eventId = `evt_v1_${common.hash(location_key).slice(0, 20)}_${dt}`;
      const snapshotId = `snap_fixture_${i}`;

      let replay = await replayFixture.createSizedReplay(5000, { eventId, snapshotId });
      replay = JSON.parse(JSON.stringify(replay).replaceAll('2026-09-09', dt));
      const bytes = Buffer.from(common.canonicalJson(replay));
      const compressed = gzipSync(bytes);
      objects.set(snapshotId, compressed);

      const predScore = (i * 23) % 101;
      const baseScore = i % 4 === 0 ? null : (i * 19) % 101;

      const row = Object.fromEntries(
        datasetSchemaModule.SNAPSHOT_OFFLINE_FIELDS.filter(x => x !== 'lead_time_minutes').map(name => [name, null])
      );
      Object.assign(row, replayFixture.snapshotRowForReplay(replay, { score: predScore, level: '很差', baseline_score: baseScore }));
      for (const k of Object.keys(row)) {
        if (row[k] === undefined) row[k] = null;
      }

      Object.assign(row, {
        event_date_local: dt,
        idempotency_key: `key_${i}`,
        location_key,
        location_source: 'qweather',
        location_id,
        query_id: `q_${i}`,
        sunset_time_local: `${dt}T18:30:00+08:00`,
        prediction_time_epoch: Date.parse(row.prediction_time_utc),
        submitted_at_epoch: Date.parse(`${dt}T04:14:00Z`),
        submitted_at_utc: `${dt}T04:14:00.000Z`,
        is_real_sounding: 1,
        replay_sha256: common.hash(bytes),
        replay_size_bytes: compressed.length,
        replay_saved_at_utc: `${dt}T04:15:00.000Z`,
        replay_updated_at_utc: `${dt}T04:15:00.000Z`
      });
      insert('prediction_snapshots', row);

      const { RATING_LABELS } = await import('../server/event-dataset.js');
      // Observation rating
      const ratings = ['poor', 'fair', 'good', 'very_good', 'excellent'];
      let obsRating = ratings[i % 5];
      if (d === 1 && options.validationRatingOverride) {
        obsRating = options.validationRatingOverride(i, obsRating);
      }
      // If options.testRatingOverride is provided and this is in the TEST split (d === 2)
      if (d === 2 && options.testRatingOverride) {
        obsRating = options.testRatingOverride(i, obsRating);
      }

      for (let j = 0; j < 2; j++) {
        insert('sunset_observations', {
          id: `obs_${i}_${j}`,
          submission_id: `sub_${i}_${j}`,
          event_id: eventId,
          snapshot_id: null,
          ...Object.fromEntries([
            'event_date_local', 'location_key', 'city', 'country', 'admin1',
            'latitude', 'longitude', 'location_source', 'location_id', 'timezone',
            'sunset_time_utc', 'sunset_time_local'
          ].map(k => [k, row[k]])),
          submitted_at_utc: `${dt}T11:00:00.000Z`,
          submitted_at_epoch: Date.parse(`${dt}T11:00:00Z`),
          rating: obsRating,
          rating_label: RATING_LABELS[obsRating],
          source: j === 0 ? 'rednote_manual' : 'user',
          confidence: null,
          evidence_count: null,
          dataset_schema_version: 3
        });
      }
    }
  }

  const cutoff = '2026-09-14T00:00:00.000Z';
  const source = {
    async query(sql) {
      return sql.includes('AS cutoff_epoch')
        ? [{ cutoff_epoch: Date.parse(cutoff) }]
        : sqlite.prepare(sql).all().map(x => ({ ...x }));
    },
    async download(row) {
      return objects.get(row.id);
    }
  };

  const rawOut = path.join(tempRoot, options.suffix ? `raw_${options.suffix}` : 'raw');
  const gtOut = path.join(tempRoot, options.suffix ? `gt_${options.suffix}` : 'gt');
  const modelOut = path.join(tempRoot, options.suffix ? `model_${options.suffix}` : 'model');

  const raw = await exporter.exportDataset(
    parser.parseExportArgs(['--from', date(0), '--to', date(counts.length - 1), '--cutoff', cutoff, '--output', rawOut]),
    { source, createdAt: cutoff }
  );
  const gt = await buildGroundTruth(raw.directory, { output: gtOut });
  const model = await buildModelDataset(raw.directory, gt.directory, { output: modelOut });

  return {
    rawDir: raw.directory,
    gtDir: gt.directory,
    modelDir: model.directory,
    close: () => sqlite.close()
  };
}

module.exports = { createSyntheticPipeline, date };
