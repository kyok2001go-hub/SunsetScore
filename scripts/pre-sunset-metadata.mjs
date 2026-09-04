import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUSES = Object.freeze({
  DRY_RUN: 'DRY_RUN',
  SUBMITTED: 'SUBMITTED',
  SKIPPED_CITY_MISMATCH: 'SKIPPED_CITY_MISMATCH',
  SKIPPED_INCOMPLETE: 'SKIPPED_INCOMPLETE',
  FAILED_NAVIGATION: 'FAILED_NAVIGATION',
  FAILED_PREDICTION: 'FAILED_PREDICTION',
  FAILED_SUBMISSION: 'FAILED_SUBMISSION'
});

export const DEFAULT_CITIES = Object.freeze([
  '深圳', '广州', '北京', '上海', '兰州', '西宁', '银川',
  '西安', '太原', '武汉', '长沙', '南京', '杭州', '昆明'
]);

export const MAX_METADATA_CITIES = 20;
export const PREDICTION_RETRY_MIN_DELAY_MS = 15000;
export const PREDICTION_RETRY_MAX_DELAY_MS = 30000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function booleanValue(value) {
  return String(value == null ? 'false' : value).trim().toLowerCase() === 'true';
}

export function normalizeCity(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, '').replace(/市$/, '');
}

export function cityMatches(expected, actual) {
  const expectedName = normalizeCity(expected);
  const actualName = normalizeCity(actual);
  return !!expectedName && expectedName === actualName;
}

export function parseCities(value) {
  if (!String(value || '').trim()) return Array.from(DEFAULT_CITIES);
  const seen = new Set();
  return String(value).split(/[,，\n]/).map((city) => city.trim()).filter((city) => {
    const key = normalizeCity(city);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateSlot(value) {
  const slot = String(value == null ? '' : value).trim();
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(slot)) {
    throw new Error('METADATA_SLOT must use HHMM between 0000 and 2359');
  }
  return slot;
}

export function validateRunType(value, fallback = 'manual') {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'manual' || raw === 'scheduled') return raw;
  throw new Error('METADATA_RUN_TYPE must be manual or scheduled');
}

export function snapshotSubmission(config) {
  const runType = validateRunType(config && config.runType);
  return {
    source: runType === 'scheduled' ? 'github_schedule' : 'github_manual',
    scheduledSlot: validateSlot(config && config.slot)
  };
}

export function validatePrediction(result) {
  const invalid = [];
  if (!result || typeof result !== 'object') return { valid: false, invalid: ['result'] };
  if (!String(result.city || '').trim()) invalid.push('city');
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) invalid.push('score');
  if (!String(result.level || '').trim()) invalid.push('level');
  if (!String(result.queryId || '').trim()) invalid.push('queryId');
  if (!String(result.appVersion || '').trim()) invalid.push('appVersion');
  if (!String(result.modelVersion || '').trim()) invalid.push('modelVersion');
  if (!String(result.predictionTimeUtc || '').trim() || !Number.isFinite(Date.parse(result.predictionTimeUtc))) {
    invalid.push('predictionTimeUtc');
  }
  if (!Number.isFinite(result.latitude) || Math.abs(result.latitude) > 90) invalid.push('latitude');
  if (!Number.isFinite(result.longitude) || Math.abs(result.longitude) > 180) invalid.push('longitude');
  return { valid: invalid.length === 0, invalid };
}

export function safeErrorMessage(error) {
  let message = error && error.message ? String(error.message) : String(error || 'Unknown error');
  message = message
    .replace(/https?:\/\/[^\s)]+/gi, '[URL]')
    .replace(/\b(api[_-]?key|authorization|cookie|token)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 300) || 'Unknown error';
}

function errorCode(error, fallback) {
  const value = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z0-9_]{2,80}$/.test(value) ? value : fallback;
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function statusForStage(stage) {
  if (stage === 'submission') return STATUSES.FAILED_SUBMISSION;
  if (stage === 'navigation' || stage === 'setup') return STATUSES.FAILED_NAVIGATION;
  return STATUSES.FAILED_PREDICTION;
}

function resultRecord(city, index, startedAtMs) {
  return {
    index,
    requestedCity: city,
    actualCity: null,
    score: null,
    level: null,
    status: null,
    queryId: null,
    predictionTimeUtc: null,
    appVersion: null,
    modelVersion: null,
    startedAtUtc: new Date(startedAtMs).toISOString(),
    finishedAtUtc: null,
    durationMs: null,
    snapshotId: null,
    errorCode: null,
    errorMessage: null,
    screenshot: null
  };
}

function applyPrediction(record, prediction) {
  record.actualCity = prediction && prediction.city || null;
  record.score = prediction && Number.isFinite(prediction.score) ? prediction.score : null;
  record.level = prediction && prediction.level || null;
  record.queryId = prediction && prediction.queryId || null;
  record.predictionTimeUtc = prediction && prediction.predictionTimeUtc || null;
  record.appVersion = prediction && prediction.appVersion || null;
  record.modelVersion = prediction && prediction.modelVersion || null;
}

function finishRecord(record, nowMs) {
  record.finishedAtUtc = new Date(nowMs).toISOString();
  record.durationMs = Math.max(0, nowMs - Date.parse(record.startedAtUtc));
  return record;
}

function shouldCapture(status) {
  return status && status !== STATUSES.DRY_RUN && status !== STATUSES.SUBMITTED;
}

export async function collectCity(city, index, config, adapter, attemptOptions = {}) {
  const startedAtMs = Date.now();
  const record = resultRecord(city, index, startedAtMs);
  let session = null;
  let stage = 'setup';

  try {
    session = await adapter.create(city, index);
    stage = 'navigation';
    await adapter.navigate(session, city, config);
    stage = 'prediction';
    const prediction = await adapter.waitForPrediction(session, config);
    applyPrediction(record, prediction);

    if (!cityMatches(city, prediction && prediction.city)) {
      record.status = STATUSES.SKIPPED_CITY_MISMATCH;
      record.errorCode = 'CITY_MISMATCH';
      record.errorMessage = '预测结果城市与请求城市不一致';
    } else {
      const validation = validatePrediction(prediction);
      if (!validation.valid) {
        record.status = STATUSES.SKIPPED_INCOMPLETE;
        record.errorCode = 'INCOMPLETE_RESULT';
        record.errorMessage = '预测结果缺少或包含非法字段：' + validation.invalid.join(', ');
      } else if (!config.submit) {
        record.status = STATUSES.DRY_RUN;
      } else {
        stage = 'submission';
        const response = await adapter.submit(session, snapshotSubmission(config), config);
        if (!response || response.remote !== true) {
          record.status = STATUSES.FAILED_SUBMISSION;
          record.errorCode = response && response.cooldown ? 'SUBMISSION_COOLDOWN' : 'REMOTE_NOT_CONFIRMED';
          record.errorMessage = safeErrorMessage(response && response.error || '服务器未明确确认保存成功');
        } else {
          record.status = STATUSES.SUBMITTED;
          record.snapshotId = response.id || null;
        }
      }
    }
  } catch (error) {
    record.status = statusForStage(stage);
    record.errorCode = errorCode(error, stage === 'submission' ? 'SUBMISSION_ERROR'
      : stage === 'navigation' || stage === 'setup' ? 'NAVIGATION_ERROR' : 'PREDICTION_ERROR');
    record.errorMessage = safeErrorMessage(error);
  } finally {
    if (session && attemptOptions.captureFailure !== false && shouldCapture(record.status)) {
      try {
        record.screenshot = await adapter.screenshot(session, city, index, record.status, config);
      } catch {
        // Diagnostics must never replace the original city outcome.
      }
    }
    if (session) {
      try { await adapter.close(session); } catch { /* best effort */ }
    }
  }

  return finishRecord(record, Date.now());
}

export function predictionRetryDelayMs(random = Math.random) {
  const value = Number(random());
  const ratio = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Math.round(PREDICTION_RETRY_MIN_DELAY_MS +
    (PREDICTION_RETRY_MAX_DELAY_MS - PREDICTION_RETRY_MIN_DELAY_MS) * ratio);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectCityWithPredictionRetry(city, index, config, adapter, runtime = {}) {
  const first = await collectCity(city, index, config, adapter, { captureFailure: false });
  if (first.status !== STATUSES.FAILED_PREDICTION) return first;

  const delayMs = predictionRetryDelayMs(runtime.random || Math.random);
  if (typeof runtime.onRetry === 'function') {
    runtime.onRetry({ city, index, delayMs, errorCode: first.errorCode });
  }
  await (runtime.sleep || sleep)(delayMs);

  // collectCity closes the first attempt in finally. A second call therefore
  // creates a fresh BrowserContext/Page and can submit at most once.
  const retried = await collectCity(city, index, config, adapter);
  retried.startedAtUtc = first.startedAtUtc;
  retried.durationMs = Math.max(0, Date.parse(retried.finishedAtUtc) - Date.parse(first.startedAtUtc));
  return retried;
}

export async function runWorkerPool(items, concurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(items.length, boundedInteger(concurrency, 2, 1, 2));

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await handler(items[index], index);
      } catch (error) {
        const now = Date.now();
        const record = resultRecord(items[index], index, now);
        record.status = STATUSES.FAILED_PREDICTION;
        record.errorCode = 'COLLECTOR_UNHANDLED';
        record.errorMessage = safeErrorMessage(error);
        results[index] = finishRecord(record, now);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function readConfig(env = process.env) {
  const baseUrl = new URL(String(env.SUNSETSCORE_URL || 'https://sunsetscore.pages.dev'));
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error('SUNSETSCORE_URL must use HTTP or HTTPS');
  const cities = parseCities(env.METADATA_CITIES);
  if (!cities.length) throw new Error('METADATA_CITIES does not contain a valid city');
  if (cities.length > MAX_METADATA_CITIES) {
    throw new Error('METADATA_CITIES exceeds maximum of ' + MAX_METADATA_CITIES);
  }
  const slot = validateSlot(env.METADATA_SLOT);
  const scheduledTimezone = String(env.METADATA_TIMEZONE || 'Asia/Shanghai').trim();
  if (!scheduledTimezone) throw new Error('METADATA_TIMEZONE must not be empty');
  const runType = validateRunType(env.METADATA_RUN_TYPE);
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    cities,
    submit: booleanValue(env.SUBMIT),
    concurrency: boundedInteger(env.METADATA_CONCURRENCY, 2, 1, 2),
    predictionTimeoutMs: boundedInteger(env.PREDICTION_TIMEOUT_MS, 120000, 1000, 180000),
    navigationTimeoutMs: boundedInteger(env.NAVIGATION_TIMEOUT_MS, 45000, 1000, 120000),
    artifactsDir: path.resolve(String(env.ARTIFACTS_DIR || 'artifacts')),
    trigger: String(env.METADATA_TRIGGER || env.GITHUB_EVENT_NAME || 'workflow_dispatch').trim() || 'workflow_dispatch',
    runType,
    slot,
    slotLocal: slot.slice(0, 2) + ':' + slot.slice(2),
    scheduledTimezone
  };
}

function predictionFromPage() {
  const SS = window.SunsetScore;
  const result = SS && SS.ui && typeof SS.ui.getCurrentResult === 'function'
    ? SS.ui.getCurrentResult() : null;
  if (!result) return null;
  return {
    city: result.city,
    score: result.score,
    level: result.level,
    queryId: result.query_id,
    predictionTimeUtc: result.prediction_time_utc,
    appVersion: result.app_version,
    modelVersion: result.model_version,
    latitude: result.latitude,
    longitude: result.longitude
  };
}

export function createPlaywrightAdapter(browser) {
  return {
    async create() {
      const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      const page = await context.newPage();
      return { context, page };
    },

    async navigate(session, city, config) {
      const url = new URL('/', config.baseUrl + '/');
      url.searchParams.set('city', city);
      const response = await session.page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs
      });
      if (response && response.status() >= 400) {
        throw makeError('HTTP_' + response.status(), '页面导航返回HTTP ' + response.status());
      }
    },

    async waitForPrediction(session, config) {
      const handle = await session.page.waitForFunction(() => {
        const SS = window.SunsetScore;
        const result = SS && SS.ui && typeof SS.ui.getCurrentResult === 'function'
          ? SS.ui.getCurrentResult() : null;
        if (result) {
          if (!SS.snapshotService || typeof SS.snapshotService.submit !== 'function') {
            return { kind: 'error', message: '预测快照服务不可用' };
          }
          return { kind: 'result' };
        }
        const errorNode = document.getElementById('error');
        if (errorNode && !errorNode.classList.contains('hidden') && errorNode.textContent.trim()) {
          return { kind: 'error', message: errorNode.textContent.trim().slice(0, 300) };
        }
        return null;
      }, null, { timeout: config.predictionTimeoutMs });
      const ready = await handle.jsonValue();
      await handle.dispose();
      if (ready && ready.kind === 'error') throw makeError('PAGE_PREDICTION_ERROR', ready.message || '页面预测失败');
      const prediction = await session.page.evaluate(predictionFromPage);
      if (!prediction) throw makeError('MISSING_CURRENT_RESULT', '页面未生成预测结果');
      return prediction;
    },

    async submit(session, submission) {
      return session.page.evaluate(async (input) => {
        const SS = window.SunsetScore;
        const result = SS && SS.ui && typeof SS.ui.getCurrentResult === 'function'
          ? SS.ui.getCurrentResult() : null;
        if (!result || !SS.snapshotService || typeof SS.snapshotService.submit !== 'function') {
          throw new Error('预测快照服务或当前预测结果不可用');
        }
        return SS.snapshotService.submit(result, input);
      }, submission);
    },

    async screenshot(session, city, index, status, config) {
      const filename = 'city-' + String(index + 1).padStart(2, '0') + '-' + status.toLowerCase() + '.png';
      const target = path.join(config.artifactsDir, filename);
      await session.page.screenshot({ path: target, fullPage: true });
      return filename;
    },

    async close(session) {
      await session.context.close();
    }
  };
}

function markdown(value) {
  return String(value == null ? '—' : value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function buildReport(config, startedAtMs, finishedAtMs, results, env = process.env) {
  return {
    workflowRunId: env.GITHUB_RUN_ID || null,
    workflowSha: env.GITHUB_SHA || null,
    mode: config.submit ? 'SUBMIT' : 'DRY_RUN',
    trigger: config.trigger || null,
    runType: config.runType || 'manual',
    slot: config.slot,
    slotLocal: config.slotLocal,
    scheduledTimezone: config.scheduledTimezone,
    requestedCities: Array.from(config.cities || []),
    startedAtUtc: new Date(startedAtMs).toISOString(),
    finishedAtUtc: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    concurrency: config.concurrency,
    results
  };
}

export function summaryMarkdown(report) {
  const counts = report.results.reduce((map, item) => {
    map[item.status] = (map[item.status] || 0) + 1;
    return map;
  }, {});
  const lines = [
    '# SunsetScore Pre-Sunset Metadata', '',
    '- Mode: **' + report.mode + '**',
    '- Trigger: **' + markdown(report.trigger) + '**',
    '- Run type: **' + markdown(report.runType) + '**',
    '- Slot: **' + report.slotLocal + ' ' + report.scheduledTimezone + '**',
    '- Requested cities: **' + report.requestedCities.length + '**',
    '- Actual start: **' + report.startedAtUtc + '**',
    '- Duration: **' + Math.round(report.durationMs / 1000) + 's**',
    '- Counts: **' + Object.entries(counts).map(([key, value]) => key + '=' + value).join(', ') + '**', '',
    '| 城市 | 实际城市 | SunsetScore | 等级 | 预测时间UTC | 结果 |',
    '| --- | --- | ---: | --- | --- | --- |'
  ];
  report.results.forEach((item) => {
    lines.push('| ' + [item.requestedCity, item.actualCity, item.score, item.level,
      item.predictionTimeUtc, item.status].map(markdown).join(' | ') + ' |');
  });
  return lines.join('\n') + '\n';
}

export async function writeReport(report, config, env = process.env) {
  await mkdir(config.artifactsDir, { recursive: true });
  const reportPath = path.join(config.artifactsDir, 'pre-sunset-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summaryMarkdown(report), 'utf8');
  return reportPath;
}

function hasUnhealthyResult(results) {
  return results.some((item) => item.status.startsWith('FAILED_') || item.status.startsWith('SKIPPED_'));
}

export async function main(env = process.env) {
  const config = readConfig(env);
  await mkdir(config.artifactsDir, { recursive: true });
  const startedAtMs = Date.now();
  let browser = null;
  let results;

  console.log('SunsetScore Pre-Sunset Metadata');
  console.log('Mode:', config.submit ? 'SUBMIT' : 'DRY RUN');
  console.log('Trigger:', config.trigger);
  console.log('Run Type:', config.runType);
  console.log('Slot:', config.slot, config.scheduledTimezone);
  console.log('Cities:', config.cities.join(', '));
  console.log('Concurrency:', config.concurrency);

  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const adapter = createPlaywrightAdapter(browser);
    results = await runWorkerPool(config.cities, config.concurrency, async (city, index) => {
      console.log('[' + (index + 1) + '/' + config.cities.length + '] ' + city + ' started');
      const result = await collectCityWithPredictionRetry(city, index, config, adapter, {
        onRetry: ({ delayMs, errorCode }) => {
          console.log('[' + (index + 1) + '/' + config.cities.length + '] ' + city +
            ' prediction retry in ' + Math.round(delayMs / 1000) + 's (' + errorCode + ')');
        }
      });
      console.log('[' + (index + 1) + '/' + config.cities.length + '] ' + city + ' -> ' + result.status);
      return result;
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    results = config.cities.map((city, index) => {
      const now = Date.now();
      const record = resultRecord(city, index, now);
      record.status = STATUSES.FAILED_NAVIGATION;
      record.errorCode = 'BROWSER_START_FAILED';
      record.errorMessage = message;
      return finishRecord(record, now);
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best effort */ }
    }
  }

  const report = buildReport(config, startedAtMs, Date.now(), results, env);
  const reportPath = await writeReport(report, config, env);
  console.table(results.map((item) => ({
    city: item.requestedCity,
    actual: item.actualCity || '-',
    score: item.score == null ? '-' : item.score,
    status: item.status
  })));
  console.log('Report:', reportPath);
  if (hasUnhealthyResult(results)) process.exitCode = 1;
  return report;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
