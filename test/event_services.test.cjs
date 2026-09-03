const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

const FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/baseline.js', 'js/feedback_service.js', 'js/event_service.js',
  'js/snapshot_service.js', 'js/observation_service.js'
];

function prediction(overrides = {}) {
  const sunset = overrides.sunset_time_utc || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(sunset));
  return {
    query_id: 'qid-v240', city: '深圳', admin1: '广东', country: '中国',
    latitude: 22.5431, longitude: 114.0579, location_source: 'qweather',
    location_id: 'qweather:101280601', timezone: 'Asia/Shanghai', date: localDate,
    sunset_time_utc: sunset,
    sunset_time_local: '2026-09-03 18:39', sunset_local: '18:39', sunset_azimuth: 278,
    prediction_time_utc: new Date().toISOString(), score: 68, level: '很好',
    components: {}, data: {}, cloud_structure: {}, cloud_motion: {}, sky_evolution: {},
    all_day_sky_state: {}, regime_state: {},
    ...overrides
  };
}

test('browser event service uses provider identity, not display city aliases', async () => {
  const SS = load(createRuntime(), FILES);
  const first = await SS.eventService.context(prediction());
  const alias = await SS.eventService.context(prediction({ city: 'Shenzhen', location_id: '101280601' }));
  const server = await import('../server/event-dataset.js');
  const verified = await server.normalizeEventContext(first);
  assert.equal(first.location_key, 'qweather:101280601');
  assert.equal(first.event_id, alias.event_id);
  assert.equal(verified.event_id, first.event_id);
  assert.match(first.event_id, /^evt_v1_[a-f0-9]{20}_2026-09-03$/);
});

test('snapshot service emits explicit source/slot and no fake observation fields', async () => {
  const SS = load(createRuntime(), FILES);
  const payload = await SS.snapshotService.buildPayload(prediction(), {
    source: 'github_schedule', scheduledSlot: '1613'
  });
  assert.equal(payload.snapshot_source, 'github_schedule');
  assert.equal(payload.scheduled_slot, '1613');
  assert.match(payload.idempotency_key, /^snap_v1_[a-f0-9]{64}$/);
  assert.equal(payload.dataset_schema_version, 1);
  assert.equal('user_rating' in payload, false);
  assert.equal('user_comment' in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /META_ONLY/);
});

test('observation retry reuses its caller submission id and source comes from the URL runtime', async () => {
  const submitted = [];
  const runtime = createRuntime({
    fetch: async (url, init) => {
      submitted.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true, id: 'obs-1', snapshotId: 'snap-1', snapshotSaved: true }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  const SS = load(runtime, FILES);
  SS.runtime = { observationSource: 'rednote_agent' };
  const response = await SS.observationService.submit(prediction(), {
    submissionId: 'same-on-manual-retry', rating: 'great', comment: '现场照片'
  });
  assert.equal(response.remote, true);
  assert.equal(submitted[0].url, '/api/observation');
  assert.equal(submitted[0].body.observation.submission_id, 'same-on-manual-retry');
  assert.equal(submitted[0].body.observation.source, 'rednote_agent');
  assert.equal('rating_label' in submitted[0].body.observation, false);
  assert.equal(submitted[0].body.snapshot.snapshot_source, 'user_feedback');
  await SS.observationService.submit(prediction(), {
    submissionId: 'same-on-manual-retry', rating: 'great', comment: '现场照片'
  });
  assert.equal(SS.baseline.getFeedbackList().length, 1, 'manual retry must not duplicate the local backup');
});
