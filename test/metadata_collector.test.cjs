const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRuntime, load } = require('./helpers.cjs');

const collectorPromise = import(pathToFileURL(join(__dirname, '..', 'scripts', 'pre-sunset-metadata.mjs')).href);

function prediction(city, values = {}) {
  return {
    city,
    score: 0,
    level: '很差',
    queryId: 'qid-' + city,
    predictionTimeUtc: '2026-08-31T04:13:00.000Z',
    appVersion: '2.3.7',
    modelVersion: '2.3.7',
    latitude: 22.54,
    longitude: 114.06,
    ...values
  };
}

function fakeAdapter(behavior = {}) {
  const calls = { submit: [], close: 0, screenshot: 0 };
  return {
    calls,
    async create(city) { return { city }; },
    async navigate(session) {
      if (behavior.navigationError) throw Object.assign(new Error('navigation failed'), { code: 'TEST_NAVIGATION' });
    },
    async waitForPrediction(session) {
      if (behavior.predictionError) throw Object.assign(new Error('prediction failed'), { code: 'TEST_PREDICTION' });
      return behavior.prediction || prediction(session.city);
    },
    async submit(session, feedback) {
      calls.submit.push({ city: session.city, feedback });
      if (behavior.submissionError) throw Object.assign(new Error('submission failed'), { code: 'TEST_SUBMISSION' });
      return behavior.response || { remote: true, id: 'fb-test' };
    },
    async screenshot() { calls.screenshot += 1; return 'city-error.png'; },
    async close() { calls.close += 1; }
  };
}

function config(submit = false) {
  return {
    submit,
    predictionTimeoutMs: 120000,
    navigationTimeoutMs: 45000,
    artifactsDir: 'artifacts'
  };
}

test('city matching is strict after suffix normalization and never uses broad containment', async () => {
  const collector = await collectorPromise;
  assert.equal(collector.cityMatches('深圳', '深圳市'), true);
  assert.equal(collector.cityMatches(' 深圳市 ', '深圳'), true);
  assert.equal(collector.cityMatches('北京', '北京市朝阳区'), false);
  assert.equal(collector.cityMatches('西安', '西安市长安区'), false);
  assert.equal(collector.cityMatches('', '深圳'), false);
});

test('configuration defaults to fourteen cities, clamps concurrency and supports a controlled city subset', async () => {
  const collector = await collectorPromise;
  const defaults = collector.readConfig({});
  assert.equal(defaults.cities.length, 14);
  assert.equal(defaults.concurrency, 2);
  assert.equal(defaults.submit, false);
  assert.equal(defaults.baseUrl, 'https://sunsetscore.pages.dev');
  const subset = collector.readConfig({ METADATA_CITIES: '深圳，广州,深圳', METADATA_CONCURRENCY: '9', SUBMIT: 'true' });
  assert.deepEqual(subset.cities, ['深圳', '广州']);
  assert.equal(subset.concurrency, 2);
  assert.equal(subset.submit, true);
  assert.throws(() => collector.readConfig({ METADATA_CITIES: '，,  ' }), /valid city/);
});

test('prediction completeness preserves a legitimate zero score and rejects invalid required metadata', async () => {
  const collector = await collectorPromise;
  assert.deepEqual(collector.validatePrediction(prediction('深圳')), { valid: true, invalid: [] });
  const invalid = collector.validatePrediction(prediction('深圳', {
    score: Number.NaN, predictionTimeUtc: 'not-a-date', latitude: 91, appVersion: ''
  }));
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.invalid.sort(), ['appVersion', 'latitude', 'predictionTimeUtc', 'score']);
});

test('metadata feedback uses the same production payload builder as a manual poor submission', async () => {
  const collector = await collectorPromise;
  const runtime = createRuntime();
  const SS = load(runtime, [
    'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
    'js/baseline.js', 'js/feedback_service.js'
  ]);
  const result = {
    query_id: 'qid-meta', city: '深圳', country: '中国', latitude: 22.54, longitude: 114.06,
    timezone: 'Asia/Shanghai', date: '2026-08-31', sunset_local: '18:40', sunset_azimuth: 280,
    score: 0, level: '很差', components: {}, data: {}, cloud_structure: {}, cloud_motion: {},
    sky_evolution: {}, all_day_sky_state: {}, regime_state: {}, nowcast_active: false
  };
  const fixedNow = Date.parse('2026-08-31T04:13:00.000Z');
  const feedback = { ...collector.metadataFeedback(), nowUtcMs: fixedNow };
  const automated = SS.feedbackService.buildPayload(result, feedback);
  const manual = SS.feedbackService.buildPayload(result, {
    rating: 'poor', ratingLabel: '🌧️ 完全无霞', comment: collector.META_ONLY_COMMENT, nowUtcMs: fixedNow
  });
  assert.deepEqual(automated, manual);
  assert.equal(automated.user_rating, 'poor');
  assert.equal(automated.user_comment.startsWith('[META_ONLY][SLOT:1200]'), true);
  assert.equal(automated.predicted_score, 0);
});

test('collector emits every required status and dry run never submits', async () => {
  const collector = await collectorPromise;
  const dryAdapter = fakeAdapter();
  assert.equal((await collector.collectCity('深圳', 0, config(false), dryAdapter)).status, collector.STATUSES.DRY_RUN);
  assert.equal(dryAdapter.calls.submit.length, 0);

  const submittedAdapter = fakeAdapter();
  const submitted = await collector.collectCity('深圳', 0, config(true), submittedAdapter);
  assert.equal(submitted.status, collector.STATUSES.SUBMITTED);
  assert.equal(submitted.feedbackId, 'fb-test');
  assert.deepEqual(submittedAdapter.calls.submit[0].feedback, collector.metadataFeedback());

  const mismatch = await collector.collectCity('深圳', 0, config(true), fakeAdapter({ prediction: prediction('广州') }));
  assert.equal(mismatch.status, collector.STATUSES.SKIPPED_CITY_MISMATCH);

  const incomplete = await collector.collectCity('深圳', 0, config(true), fakeAdapter({ prediction: prediction('深圳', { score: null }) }));
  assert.equal(incomplete.status, collector.STATUSES.SKIPPED_INCOMPLETE);

  const navigation = await collector.collectCity('深圳', 0, config(true), fakeAdapter({ navigationError: true }));
  assert.equal(navigation.status, collector.STATUSES.FAILED_NAVIGATION);

  const predictionFailure = await collector.collectCity('深圳', 0, config(true), fakeAdapter({ predictionError: true }));
  assert.equal(predictionFailure.status, collector.STATUSES.FAILED_PREDICTION);

  const submissionFailure = await collector.collectCity('深圳', 0, config(true), fakeAdapter({ response: { remote: false, error: 'D1 unavailable' } }));
  assert.equal(submissionFailure.status, collector.STATUSES.FAILED_SUBMISSION);
});

test('two-worker pool never exceeds concurrency, continues after failure and restores input order', async () => {
  const collector = await collectorPromise;
  const cities = ['深圳', '广州', '北京', '上海', '兰州'];
  let active = 0, maximum = 0;
  const results = await collector.runWorkerPool(cities, 2, async (city, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, index % 2 ? 2 : 5));
    active -= 1;
    if (city === '北京') throw new Error('fixture failure');
    return { requestedCity: city, status: collector.STATUSES.DRY_RUN };
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results.map((item) => item.requestedCity), cities);
  assert.equal(results[2].status, collector.STATUSES.FAILED_PREDICTION);
  assert.equal(results[4].status, collector.STATUSES.DRY_RUN);
});

test('report records actual timing, fixed slot, statuses and produces ordered Markdown', async () => {
  const collector = await collectorPromise;
  const results = [
    { requestedCity: '深圳', actualCity: '深圳', score: 68, level: '不错', predictionTimeUtc: '2026-08-31T04:13:00Z', status: 'DRY_RUN' },
    { requestedCity: '广州', actualCity: null, score: null, level: null, predictionTimeUtc: null, status: 'FAILED_PREDICTION' }
  ];
  const report = collector.buildReport({ submit: false, slotLocal: '12:00', scheduledTimezone: 'Asia/Shanghai', concurrency: 2 },
    Date.parse('2026-08-31T04:13:00Z'), Date.parse('2026-08-31T04:14:00Z'), results,
    { GITHUB_RUN_ID: '123', GITHUB_SHA: 'abc' });
  assert.equal(report.durationMs, 60000);
  assert.equal(report.slotLocal, '12:00');
  assert.equal(report.workflowRunId, '123');
  const markdown = collector.summaryMarkdown(report);
  assert.ok(markdown.indexOf('| 深圳 |') < markdown.indexOf('| 广州 |'));
  assert.match(markdown, /DRY_RUN=1/);
  assert.match(markdown, /FAILED_PREDICTION=1/);
});

test('error summaries redact URLs and common credential names without serializing stacks', async () => {
  const collector = await collectorPromise;
  const error = new Error('fetch https://example.test/path?city=深圳 authorization=secret\nfailed');
  error.stack = 'STACK SECRET';
  const message = collector.safeErrorMessage(error);
  assert.doesNotMatch(message, /example\.test|secret|STACK/);
  assert.match(message, /\[URL\]|\[REDACTED\]/);
});

test('workflow and package keep the approved schedule, bounded concurrency and dry-run controls', () => {
  const root = join(__dirname, '..');
  const workflow = readFileSync(join(root, '.github', 'workflows', 'pre-sunset-metadata.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

  assert.match(workflow, /cron:\s*'13 12 \* \* \*'/);
  assert.match(workflow, /timezone:\s*'Asia\/Shanghai'/);
  assert.match(workflow, /timeout-minutes:\s*60/);
  assert.match(workflow, /SUNSETSCORE_URL:\s*https:\/\/sunsetscore\.pages\.dev/);
  assert.match(workflow, /METADATA_CONCURRENCY:\s*'2'/);
  assert.match(workflow, /submit:\s*\n\s*description:[\s\S]*?default:\s*false/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/upload-artifact@v6/);
  assert.equal(packageJson.scripts['metadata:collect'], 'node scripts/pre-sunset-metadata.mjs');
  assert.equal(typeof packageJson.devDependencies.playwright, 'string');
  assert.equal(typeof lock.packages['node_modules/playwright'].version, 'string');
});
