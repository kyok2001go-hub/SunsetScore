import {
  ADMIN_SNAPSHOT_LIST_FIELDS,
  OBSERVATION_PUBLIC_EXPORT_FIELDS,
  RATING_LABELS,
  ValidationError
} from './event-dataset.js';

const NULL_FILTER = '__NULL__';
const PREDICTION_LEVELS = Object.freeze(['极佳', '很好', '一般', '较差', '很差']);
const REGIME_LABELS = Object.freeze([
  '晴朗', '多云间晴', '雨后转晴', '雨后转晴（强）', '锋面过境', '阴天', '雾霾', '风暴逼近'
]);
const SKY_EVOLUTION_STATES = Object.freeze([
  'CLEAR', 'OPENING', 'STABLE', 'CLOSING', 'CLOUD_ARRIVING', 'UNCERTAIN'
]);
const SNAPSHOT_SOURCES = Object.freeze(['github_schedule', 'github_manual', 'user_feedback']);
const OBSERVATION_SOURCES = Object.freeze(['user', 'rednote_agent', 'rednote_manual']);
const SOURCE_LABELS = Object.freeze({
  github_schedule: '定时采集', github_manual: '手动采集', user_feedback: '用户反馈',
  user: '用户反馈', rednote_agent: 'Rednote Agent', rednote_manual: '管理员补录'
});
const SNAPSHOT_FILTERS = Object.freeze({
  event_date_local: { type: 'date' },
  city: { type: 'city' },
  predicted_level: { type: 'text', max: 30 },
  baseline_level: { type: 'text', max: 30, nullable: true },
  regime_label: { type: 'text', max: 100, nullable: true },
  sky_evolution_state: { type: 'text', max: 50, nullable: true },
  snapshot_source: { type: 'enum', values: SNAPSHOT_SOURCES }
});
const OBSERVATION_FILTERS = Object.freeze({
  event_date_local: { type: 'date' },
  city: { type: 'city' },
  rating: { type: 'enum', values: Object.keys(RATING_LABELS) },
  source: { type: 'enum', values: OBSERVATION_SOURCES }
});

const DATASETS = Object.freeze({
  snapshots: Object.freeze({
    table: 'prediction_snapshots', columns: ADMIN_SNAPSHOT_LIST_FIELDS,
    filters: SNAPSHOT_FILTERS,
    dynamicOptions: ['predicted_level', 'baseline_level', 'regime_label', 'sky_evolution_state'],
    presetOptions: {
      predicted_level: PREDICTION_LEVELS,
      baseline_level: [...PREDICTION_LEVELS, NULL_FILTER],
      regime_label: [...REGIME_LABELS, NULL_FILTER],
      sky_evolution_state: [...SKY_EVOLUTION_STATES, NULL_FILTER]
    },
    staticOptions: { snapshot_source: SNAPSHOT_SOURCES },
    staticLabels: { snapshot_source: SOURCE_LABELS }
  }),
  observations: Object.freeze({
    table: 'sunset_observations', columns: OBSERVATION_PUBLIC_EXPORT_FIELDS,
    filters: OBSERVATION_FILTERS,
    dynamicOptions: [],
    staticOptions: { rating: Object.keys(RATING_LABELS), source: OBSERVATION_SOURCES },
    staticLabels: { rating: RATING_LABELS, source: SOURCE_LABELS }
  })
});

function strictPositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationError(name + ' 必须为正整数');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ValidationError(name + ' 超出范围');
  return number;
}

export function parsePagination(params) {
  const page = params.has('page') ? strictPositiveInteger(params.get('page'), 'page') : 1;
  const pageSize = params.has('page_size') ? strictPositiveInteger(params.get('page_size'), 'page_size') : 50;
  if (![20, 50, 100].includes(pageSize)) throw new ValidationError('page_size 只能是 20、50 或 100');
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw new ValidationError('page 超出范围');
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function parseDateFilter(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('event_date_local 格式必须为 YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    throw new ValidationError('event_date_local 不是有效日期');
  }
  return value;
}

export function parseTextFilter(value, name, max) {
  const text = value.trim();
  if (Array.from(text).length > max) throw new ValidationError(name + ' 过长');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new ValidationError(name + ' 包含非法字符');
  return text;
}

export function parseEnumFilter(value, name, values) {
  if (!values.includes(value)) throw new ValidationError(name + ' 非法');
  return value;
}

export function escapeLikeLiteral(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function buildWhereFromWhitelist(params, filters) {
  const clauses = [];
  const bindings = [];
  for (const [name, rule] of Object.entries(filters)) {
    if (!params.has(name)) continue;
    const raw = params.get(name);
    if (rule.nullable && raw === NULL_FILTER) {
      clauses.push(name + ' IS NULL');
      continue;
    }
    if (raw === '') continue;
    if (rule.type === 'date') {
      clauses.push(name + ' = ?'); bindings.push(parseDateFilter(raw));
    } else if (rule.type === 'city') {
      const city = parseTextFilter(raw, name, 100);
      if (city) { clauses.push("city LIKE ? ESCAPE '\\'"); bindings.push('%' + escapeLikeLiteral(city) + '%'); }
    } else if (rule.type === 'enum') {
      clauses.push(name + ' = ?'); bindings.push(parseEnumFilter(raw, name, rule.values));
    } else {
      const text = parseTextFilter(raw, name, rule.max);
      if (text) { clauses.push(name + ' = ?'); bindings.push(text); }
    }
  }
  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', bindings };
}

export function parseAdminQuery(url, dataset) {
  const config = DATASETS[dataset];
  if (!config) throw new Error('Unknown admin dataset');
  const params = new URL(url).searchParams;
  const allowed = new Set(['page', 'page_size', 'include_filter_options', ...Object.keys(config.filters)]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new ValidationError('未知或重复的查询参数');
  }
  const pagination = parsePagination(params);
  const include = params.get('include_filter_options');
  if (include != null && include !== '0' && include !== '1') {
    throw new ValidationError('include_filter_options 只能是 0 或 1');
  }
  return { config, pagination, where: buildWhereFromWhitelist(params, config.filters), includeOptions: include === '1' };
}

export async function queryFilterOptions(db, config) {
  const options = { ...config.staticOptions };
  for (const name of config.dynamicOptions) {
    const rows = await db.prepare(`SELECT DISTINCT ${name} AS value FROM ${config.table} ORDER BY ${name} ASC`).all();
    const known = config.presetOptions?.[name] || [];
    const observed = (rows.results || []).map((row) => row.value === null ? NULL_FILTER : row.value)
      .filter((value) => value !== '');
    options[name] = [...new Set([...known, ...observed])];
  }
  return options;
}

export async function queryPagedRows(db, query) {
  const { config, pagination, where, includeOptions } = query;
  const countStatement = db.prepare(`SELECT COUNT(*) AS total FROM ${config.table}${where.sql}`);
  const count = await (where.bindings.length ? countStatement.bind(...where.bindings) : countStatement).first();
  const rows = await db.prepare(`SELECT ${config.columns.join(', ')} FROM ${config.table}${where.sql} ` +
    'ORDER BY submitted_at_epoch DESC, id DESC LIMIT ? OFFSET ?')
    .bind(...where.bindings, pagination.pageSize, pagination.offset).all();
  const total = Number(count && count.total || 0);
  const result = {
    success: true,
    columns: config.columns,
    items: rows.results || [],
    pagination: {
      page: pagination.page, page_size: pagination.pageSize,
      total, total_pages: Math.ceil(total / pagination.pageSize)
    }
  };
  if (includeOptions) {
    result.filter_options = await queryFilterOptions(db, config);
    result.filter_labels = config.staticLabels;
  }
  return result;
}
