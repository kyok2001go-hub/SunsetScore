const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');
const { database, request } = require('./d1-helper.cjs');

function setup() {
  return load(createRuntime(), [
    'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
    'js/baseline.js', 'js/evolution.js', 'js/feedback_service.js'
  ]);
}

function prediction(SS, active = true) {
  const now = Date.parse('2026-08-27T09:00:00Z');
  const result = {
    city: '深圳', timezone: 'Asia/Shanghai', date: '2026-08-27', sunset_local: '18:45',
    prediction_time_utc: new Date(now).toISOString(), hours_to_sunset: 1.75, nowcast_active: active
  };
  if (!active) {
    result.prediction_time_utc = '2026-08-27T05:59:00.000Z';
    result.hours_to_sunset = 286 / 60;
    return result;
  }
  const satellite = { available: true, coverageSeries: [{ t: now - 600000, pct: 50 }, { t: now, pct: 40 }] };
  const precip = { available: true, rainingNow: true, stopMin: null };
  const sourcesStatus = {
    radar: { available: false, status: 'EMPTY', error: '区域无有效数据' },
    satellite: { available: true, status: 'OK', error: null }
  };
  const motionForecast = { predictions: {
    m30: { summary: { avgCloudCover: 60 } },
    m60: { summary: { avgCloudCover: 50 } },
    m120: { summary: { avgCloudCover: 40 } }
  } };
  result.nowcast = { sourcesStatus, detail: { satellite, precip } };
  result.sky_evolution = SS.evolution.evaluate({
    satellite, precip, motionForecast, sourcesStatus, nowMs: now, sunsetMs: now + 105 * 60000
  });
  return result;
}

test('available satellite excluded by rain is still exported as available', () => {
  const SS = setup();
  const result = prediction(SS);
  assert.equal(result.sky_evolution.detail.satellite, null);
  const payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
  assert.equal(payload.tile_radar_available, 0);
  assert.equal(payload.tile_sat_available, 1);
  assert.equal(payload.open_prob_30m, result.sky_evolution.openProbability['30m']);
  const snapshot = JSON.parse(payload.raw_snapshot_json);
  assert.equal(snapshot.sky_evolution.probability_status, 'READY');
  assert.equal(snapshot.sky_evolution.sources_status.satellite.used_in_evolution, false);
  assert.equal(snapshot.sky_evolution.sources_status.radar.status, 'EMPTY');
});

test('off-window feedback retains null probabilities with explicit not-requested diagnostics', () => {
  const SS = setup();
  const payload = SS.feedbackService.buildPayload(prediction(SS, false), { rating: 'poor' });
  for (const horizon of [30, 60, 120]) assert.equal(payload['open_prob_' + horizon + 'm'], null);
  assert.equal(payload.tile_radar_available, 0);
  assert.equal(payload.tile_sat_available, 0);
  const snapshot = JSON.parse(payload.raw_snapshot_json);
  assert.equal(snapshot.prediction_time_utc, '2026-08-27T05:59:00.000Z');
  assert.equal(snapshot.sky_evolution.minutes_to_sunset, 286);
  assert.equal(snapshot.sky_evolution.probability_status, 'NOT_ACTIVE');
  assert.equal(snapshot.sky_evolution.sources_status.radar.status, 'NOT_REQUESTED');
  assert.equal(snapshot.sky_evolution.sources_status.radar.available, null);
});

test('telemetry preserves zero and rejects missing, nonfinite or out-of-range probabilities', () => {
  const SS = setup();
  const result = { city: '深圳', nowcast_active: true, sky_evolution: {
    openProbability: { '30m': 0, '60m': NaN, '120m': 1.1 }
  } };
  const payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
  assert.equal(payload.open_prob_30m, 0);
  assert.equal(payload.open_prob_60m, null);
  assert.equal(payload.open_prob_120m, null);
  const evo = JSON.parse(payload.raw_snapshot_json).sky_evolution;
  assert.equal(evo.probability_status, 'NO_VALID_PROBABILITY');
  assert.equal(evo.sources_status.radar.status, 'UNKNOWN');
});

test('explicit failed availability overrides a truthy detail object; legacy detail fallback remains supported', () => {
  const SS = setup();
  const result = { city: '深圳', nowcast_active: true, sky_evolution: {
    detail: { radar: { openProbability: {} }, satellite: { available: false } }
  } };
  let payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
  assert.equal(payload.tile_radar_available, 1);
  assert.equal(payload.tile_sat_available, 0);
  result.nowcast = { sourcesStatus: { radar: { available: false, status: 'FAILED', error: 'tile load failed' } } };
  payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
  assert.equal(payload.tile_radar_available, 0);
  assert.equal(JSON.parse(payload.raw_snapshot_json).sky_evolution.sources_status.radar.error, 'tile load failed');
});

// Exercise the production handlers with real SQLite, not just mocked bind arguments.
for (const legacy of [true, false]) {
  for (const mode of ['inactive', 'rain', 'zero']) {
    test(`telemetry survives payload -> ${legacy ? 'legacy' : 'current'} D1 -> JSON/CSV (${mode})`, async () => {
      const SS = setup();
      const result = prediction(SS, mode !== 'inactive');
      if (mode === 'zero') result.sky_evolution.openProbability['30m'] = 0;
      const payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
      const { DB, sqlite } = database(legacy);
      try {
        const { onRequestPost } = await import('../functions/api/feedback.js');
        const { onRequestGet } = await import('../functions/api/export.js');
        const response = await onRequestPost({ request: request(payload), env: { DB } });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);
        const ctx = (format) => ({ request: new Request('https://example.test/api/export?format=' + format), env: { DB } });
        const exported = await onRequestGet(ctx('json'));
        assert.equal(exported.status, 200);
        const [row] = await exported.json();
        const csvResponse = await onRequestGet(ctx('csv'));
        assert.equal(csvResponse.status, 200);
        const [header, csv] = (await csvResponse.text()).split('\r\n');
        const names = header.replace(/^\uFEFF/, '').split(',');
        // These numeric columns precede all comma-containing cells in this fixture.
        const cells = csv.split(',');
        for (const field of ['open_prob_30m', 'open_prob_60m', 'open_prob_120m', 'tile_radar_available', 'tile_sat_available']) {
          assert.equal(row[field], payload[field], field);
          assert.equal(cells[names.indexOf(field)], payload[field] == null ? '' : String(payload[field]), field);
        }
        assert.equal(row.raw_snapshot_json, payload.raw_snapshot_json);
      } finally { sqlite.close(); }
    });
  }
}
