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
    appVersion: '2.3.8',
    modelVersion: '2.3.8',
    latitude: 22.54,
    longitude: 114.06,
    ...values
  };
}

function fakeAdapter(behavior = {}) {
  const calls = { create: 0, navigate: 0, prediction: 0, submit: [], close: 0, screenshot: 0 };
  return {
    calls,
    async create(city) { calls.create += 1; return { city, attempt: calls.create }; },
    async navigate(session) {
      calls.navigate += 1;
      if (behavior.navigationError) throw Object.assign(new Error('navigation failed'), { code: 'TEST_NAVIGATION' });
    },
    async waitForPrediction(session) {
      calls.prediction += 1;
      if (behavior.predictionError || session.attempt <= (behavior.predictionErrors || 0)) {
        throw Object.assign(new Error('prediction failed'), { code: 'TEST_PREDICTION' });
      }
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
    cities: ['深圳'],
    trigger: 'workflow_dispatch',
    scheduleCron: null,
    slot: '1438',
    slotLocal: '14:38',
    scheduledTimezone: 'Asia/Shanghai',
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
  const defaults = collector.readConfig({ METADATA_SLOT: '1213' });
  assert.equal(defaults.cities.length, 14);
  assert.equal(defaults.concurrency, 2);
  assert.equal(defaults.submit, false);
  assert.equal(defaults.baseUrl, 'https://sunsetscore.pages.dev');
  assert.equal(defaults.slot, '1213');
  assert.equal(defaults.slotLocal, '12:13');
  const subset = collector.readConfig({
    METADATA_CITIES: '深圳，广州,深圳', METADATA_CONCURRENCY: '9', SUBMIT: 'true',
    METADATA_SLOT: '1613', METADATA_TRIGGER: 'schedule', METADATA_SCHEDULE_CRON: '13 16 * * *'
  });
  assert.deepEqual(subset.cities, ['深圳', '广州']);
  assert.equal(subset.concurrency, 2);
  assert.equal(subset.submit, true);
  assert.equal(subset.trigger, 'schedule');
  assert.equal(subset.scheduleCron, '13 16 * * *');
  assert.throws(() => collector.readConfig({ METADATA_CITIES: '，,  ', METADATA_SLOT: '1213' }), /valid city/);
});

test('slot validation accepts only four-digit local times and metadata comments use the active slot', async () => {
  const collector = await collectorPromise;
  for (const slot of ['0000', '1213', '1613', '2359']) assert.equal(collector.validateSlot(slot), slot);
  for (const slot of [undefined, '', '123', '12:13', '2360', '1260', 'abcd']) {
    assert.throws(() => collector.validateSlot(slot), /METADATA_SLOT/);
  }
  assert.equal(collector.metadataComment('1213'),
    '[META_ONLY][SLOT:1213] 自动预测快照，仅记录预测元数据，非实况反馈');
  assert.match(collector.metadataFeedback({ slot: '1613' }).comment, /^\[META_ONLY\]\[SLOT:1613\]/);
});

test('city count is limited after normalization and deduplication', async () => {
  const collector = await collectorPromise;
  const twenty = Array.from({ length: 20 }, (_, index) => '城市' + index);
  const allowed = collector.readConfig({ METADATA_CITIES: twenty.join(','), METADATA_SLOT: '1213' });
  assert.equal(allowed.cities.length, collector.MAX_METADATA_CITIES);
  assert.throws(() => collector.readConfig({
    METADATA_CITIES: twenty.concat('额外城市').join(','), METADATA_SLOT: '1213'
  }), /exceeds maximum/);
  const duplicate = collector.readConfig({
    METADATA_CITIES: twenty.concat('城市0', '城市0市').join(','), METADATA_SLOT: '1213'
  });
  assert.equal(duplicate.cities.length, 20);
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
  const feedback = { ...collector.metadataFeedback({ slot: '1213' }), nowUtcMs: fixedNow };
  const automated = SS.feedbackService.buildPayload(result, feedback);
  const manual = SS.feedbackService.buildPayload(result, {
    rating: 'poor', ratingLabel: '🌧️ 完全无霞', comment: collector.metadataComment('1213'), nowUtcMs: fixedNow
  });
  assert.deepEqual(automated, manual);
  assert.equal(automated.user_rating, 'poor');
  assert.equal(automated.user_comment.startsWith('[META_ONLY][SLOT:1213]'), true);
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
  assert.deepEqual(submittedAdapter.calls.submit[0].feedback, collector.metadataFeedback(config(true)));

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

test('prediction failure retries once after bounded backoff with a fresh context and submits at most once', async () => {
  const collector = await collectorPromise;
  const adapter = fakeAdapter({ predictionErrors: 1 });
  const delays = [];
  const result = await collector.collectCityWithPredictionRetry('深圳', 0, config(true), adapter, {
    random: () => 0,
    sleep: async (delayMs) => { delays.push(delayMs); }
  });
  assert.equal(result.status, collector.STATUSES.SUBMITTED);
  assert.deepEqual(delays, [collector.PREDICTION_RETRY_MIN_DELAY_MS]);
  assert.equal(adapter.calls.create, 2);
  assert.equal(adapter.calls.navigate, 2);
  assert.equal(adapter.calls.prediction, 2);
  assert.equal(adapter.calls.close, 2);
  assert.equal(adapter.calls.submit.length, 1);
  assert.equal(adapter.calls.screenshot, 0);
});

test('a second prediction failure becomes final and only the final attempt captures a screenshot', async () => {
  const collector = await collectorPromise;
  const adapter = fakeAdapter({ predictionErrors: 2 });
  const delays = [];
  const result = await collector.collectCityWithPredictionRetry('武汉', 9, config(false), adapter, {
    random: () => 1,
    sleep: async (delayMs) => { delays.push(delayMs); }
  });
  assert.equal(result.status, collector.STATUSES.FAILED_PREDICTION);
  assert.deepEqual(delays, [collector.PREDICTION_RETRY_MAX_DELAY_MS]);
  assert.equal(adapter.calls.create, 2);
  assert.equal(adapter.calls.close, 2);
  assert.equal(adapter.calls.submit.length, 0);
  assert.equal(adapter.calls.screenshot, 1);
});

test('navigation and submission failures never enter the prediction retry path', async () => {
  const collector = await collectorPromise;
  for (const adapter of [
    fakeAdapter({ navigationError: true }),
    fakeAdapter({ response: { remote: false, error: 'D1 unavailable' } })
  ]) {
    let slept = false;
    const result = await collector.collectCityWithPredictionRetry('深圳', 0, config(true), adapter, {
      sleep: async () => { slept = true; }
    });
    assert.equal(slept, false);
    assert.equal(adapter.calls.create, 1);
    assert.equal(adapter.calls.close, 1);
    assert.equal(adapter.calls.submit.length <= 1, true);
    assert.notEqual(result.status, collector.STATUSES.FAILED_PREDICTION);
  }
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

test('report records trigger, planned slot, requested cities, actual timing and ordered Markdown', async () => {
  const collector = await collectorPromise;
  const results = [
    { requestedCity: '深圳', actualCity: '深圳', score: 68, level: '不错', predictionTimeUtc: '2026-08-31T04:13:00Z', status: 'DRY_RUN' },
    { requestedCity: '广州', actualCity: null, score: null, level: null, predictionTimeUtc: null, status: 'FAILED_PREDICTION' }
  ];
  const report = collector.buildReport({
    submit: false, trigger: 'schedule', scheduleCron: '13 12 * * *', slot: '1213', slotLocal: '12:13',
    scheduledTimezone: 'Asia/Shanghai', concurrency: 2, cities: ['深圳', '广州']
  },
    Date.parse('2026-08-31T04:13:00Z'), Date.parse('2026-08-31T04:14:00Z'), results,
    { GITHUB_RUN_ID: '123', GITHUB_SHA: 'abc' });
  assert.equal(report.durationMs, 60000);
  assert.equal(report.slot, '1213');
  assert.equal(report.slotLocal, '12:13');
  assert.equal(report.trigger, 'schedule');
  assert.equal(report.scheduleCron, '13 12 * * *');
  assert.deepEqual(report.requestedCities, ['深圳', '广州']);
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

test('workflow parameterizes two schedules, cities and slots while preserving runtime controls', () => {
  const root = join(__dirname, '..');
  const workflow = readFileSync(join(root, '.github', 'workflows', 'pre-sunset-metadata.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

  assert.match(workflow, /cron:\s*'13 12 \* \* \*'/);
  assert.match(workflow, /cron:\s*'13 16 \* \* \*'/);
  assert.equal((workflow.match(/timezone:\s*'Asia\/Shanghai'/g) || []).length, 2);
  assert.match(workflow, /DEFAULT_METADATA_CITIES:\s*'深圳,广州,北京,上海,兰州,西宁,银川,西安,太原,武汉,长沙,南京,杭州,昆明'/);
  assert.match(workflow, /METADATA_TIMEZONE:\s*'Asia\/Shanghai'/);
  assert.match(workflow, /timeout-minutes:\s*60/);
  assert.match(workflow, /SUNSETSCORE_URL:\s*https:\/\/sunsetscore\.pages\.dev/);
  assert.match(workflow, /METADATA_CONCURRENCY:\s*'2'/);
  assert.match(workflow, /NAVIGATION_TIMEOUT_MS:\s*'45000'/);
  assert.match(workflow, /PREDICTION_TIMEOUT_MS:\s*'120000'/);
  assert.match(workflow, /submit:\s*\n\s*description:[\s\S]*?default:\s*false/);
  assert.match(workflow, /cities:\s*\n\s*description:[\s\S]*?default:\s*''/);
  assert.doesNotMatch(workflow, /city_scope|\n\s+slot:\s*\n\s+description:/);
  assert.match(workflow, /EVENT_SCHEDULE:\s*\$\{\{ github\.event\.schedule \}\}/);
  assert.match(workflow, /slot=\$\(printf '%02d%02d'/);
  assert.match(workflow, /slot=\$\(TZ="\$SCHEDULED_TIMEZONE" date \+%H%M\)/);
  assert.match(workflow, /Unsupported schedule cron/);
  assert.match(workflow, /METADATA_CITIES:\s*\$\{\{ steps\.collector-mode\.outputs\.cities \}\}/);
  assert.match(workflow, /METADATA_SLOT:\s*\$\{\{ steps\.collector-mode\.outputs\.slot \}\}/);
  assert.match(workflow, /METADATA_TRIGGER:\s*\$\{\{ steps\.collector-mode\.outputs\.trigger \}\}/);
  assert.match(workflow, /METADATA_SCHEDULE_CRON:\s*\$\{\{ steps\.collector-mode\.outputs\.schedule_cron \}\}/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /actions\/upload-artifact@v6/);
  assert.equal(packageJson.scripts['metadata:collect'], 'node scripts/pre-sunset-metadata.mjs');
  assert.equal(packageJson.version, '2.3.8');
  assert.equal(lock.version, '2.3.8');
  assert.equal(lock.packages[''].version, '2.3.8');
  assert.equal(typeof packageJson.devDependencies.playwright, 'string');
  assert.equal(typeof lock.packages['node_modules/playwright'].version, 'string');
});
