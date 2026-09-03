/**
 * Cloudflare Pages Functions - SunsetScore dataset export
 * Route: GET /api/export?dataset=<name>&format=json|csv
 * Default dataset: sunset_feedback (backward compatible)
 * Binding: env.DB (D1 database)
 * Optional auth: env.ADMIN_SECRET (Authorization: Bearer <SECRET>)
 */
import { OBSERVATION_FIELDS, SNAPSHOT_FIELDS } from '../../server/event-dataset.js';
import { feedbackColumns, feedbackEpochSql, feedbackSelectSql } from '../../server/feedback-db.js';

const MAX_EXPORT_ROWS = 5000;

const FEEDBACK_COLUMNS = Object.freeze([
  // 1. 主键与时间
  'id',
  'query_id',
  'created_at',
  'created_at_local',
  'created_at_epoch',
  'created_at_utc',

  // 2. 地理与日落天文信息
  'city',
  'country',
  'admin1',
  'latitude',
  'longitude',
  'timezone',
  'sunset_time_local',
  'sunset_azimuth',
  'twilight_minutes',
  'best_viewing_window',

  // 3. 预测总分与天况状态
  'app_version',
  'model_version',
  'schema_version',
  'predicted_score',
  'predicted_level',
  'baseline_score',
  'baseline_level',
  'regime_label',
  'regime_strength',
  'sky_evolution_state',
  'sky_evolution_factor',
  'gw_factor',

  // 4. 五大组件评分与云场结构
  'comp_sky_canvas',
  'comp_horizon',
  'comp_illumination',
  'comp_atmosphere',
  'comp_weather',
  'cloud_cover_total',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'corridor_cloud_mid',
  'corridor_cloud_high',
  'anti_sunset_score',
  'spatial_variance',
  'cloud_continuity',

  // 5. 大气环境微气象
  'aod',
  'pm25',
  'humidity',
  'surface_pressure',
  'visibility_km',
  'precipitation',

  // 6. 分层探空风场 (850 / 700 / 500 hPa)
  'layer_wind_850_speed',
  'layer_wind_850_dir',
  'layer_wind_700_speed',
  'layer_wind_700_dir',
  'layer_wind_500_speed',
  'layer_wind_500_dir',
  'is_real_sounding',

  // 7. 演化时序与侵入概率
  'open_prob_30m',
  'open_prob_60m',
  'open_prob_120m',
  'arrival_risk_30m',
  'arrival_risk_60m',
  'tile_radar_available',
  'tile_sat_available',

  // 8. 动态权重分配
  'dyn_weight_canvas',
  'dyn_weight_horizon',
  'dyn_weight_illum',
  'dyn_weight_atmo',
  'dyn_weight_weather',

  // 9. 用户实况真值标签 (Ground Truth)
  'user_rating',
  'user_rating_label',
  'user_comment',
  'user_ip_hash',
  'client_ua',

  // 10. 终极离线重演快照 (包含 33 节点网格时序)
  'raw_snapshot_json'
]);

// Direct-link exports are public while ADMIN_SECRET is unset. Keep rate-limit and
// client fingerprint fields out of the new observation dataset by default.
const PUBLIC_OBSERVATION_COLUMNS = Object.freeze(
  OBSERVATION_FIELDS.filter((name) => name !== 'user_ip_hash' && name !== 'client_ua')
);

const DATASETS = Object.freeze({
  prediction_snapshots: Object.freeze({
    table: 'prediction_snapshots',
    columns: SNAPSHOT_FIELDS,
    orderBy: 'submitted_at_epoch DESC, id DESC'
  }),
  sunset_observations: Object.freeze({
    table: 'sunset_observations',
    columns: PUBLIC_OBSERVATION_COLUMNS,
    orderBy: 'submitted_at_epoch DESC, id DESC'
  })
});

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  };
}

function errorResponse(error, status, details = {}) {
  return new Response(JSON.stringify({ success: false, error, ...details }), {
    status,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function csvCell(value) {
  if (value == null) return '';
  const cell = String(value).replace(/"/g, '""');
  return /[,\n\r"]/.test(cell) ? `"${cell}"` : cell;
}

function csvResponse(dataset, columns, rows) {
  const csvLines = [columns.join(',')];
  for (const row of rows) csvLines.push(columns.map((name) => csvCell(row[name])).join(','));
  return new Response('\uFEFF' + csvLines.join('\r\n'), {
    headers: responseHeaders({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${dataset}_${Date.now()}.csv"`,
      'X-Export-Dataset': dataset,
      'X-Export-Row-Count': String(rows.length)
    })
  });
}

function jsonResponse(dataset, rows) {
  return new Response(JSON.stringify(rows, null, 2), {
    headers: responseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'X-Export-Dataset': dataset,
      'X-Export-Row-Count': String(rows.length)
    })
  });
}

async function resolveDataset(db, name) {
  if (name === 'sunset_feedback') {
    const available = await feedbackColumns(db);
    return {
      table: 'sunset_feedback',
      columns: FEEDBACK_COLUMNS,
      selectSql: FEEDBACK_COLUMNS.map((column) => feedbackSelectSql(column, available)).join(', '),
      orderBy: feedbackEpochSql(available) + ' DESC'
    };
  }
  if (!Object.prototype.hasOwnProperty.call(DATASETS, name)) return null;
  const config = DATASETS[name];
  return { ...config, selectSql: config.columns.join(', ') };
}

async function exportRows(db, dataset, config) {
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM ${config.table}`).first();
  if (!countRow || countRow.total == null) throw new Error('DATASET_COUNT_FAILED');
  const total = Number(countRow.total);
  if (!Number.isFinite(total) || total < 0) throw new Error('DATASET_COUNT_FAILED');
  if (total > MAX_EXPORT_ROWS) {
    return {
      error: errorResponse('数据量超过单次导出上限，请等待后续版本提供分批导出', 413, {
        dataset,
        totalRows: total,
        maxRows: MAX_EXPORT_ROWS
      })
    };
  }
  const query = await db.prepare(`
    SELECT ${config.selectSql} FROM ${config.table}
    ORDER BY ${config.orderBy}
    LIMIT ?
  `).bind(MAX_EXPORT_ROWS + 1).all();
  const rows = query.results || [];
  // A concurrent insert can happen after COUNT(*); never return a silent partial file.
  if (rows.length > MAX_EXPORT_ROWS) {
    return {
      error: errorResponse('数据量超过单次导出上限，请等待后续版本提供分批导出', 413, {
        dataset,
        totalRows: rows.length,
        maxRows: MAX_EXPORT_ROWS
      })
    };
  }
  return { rows };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.DB) return errorResponse('D1 database not bound', 500);

  // Keep the existing optional Bearer protection intact. Direct browser links
  // work only while ADMIN_SECRET is intentionally not configured.
  if (env.ADMIN_SECRET) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== env.ADMIN_SECRET) {
      return errorResponse('Unauthorized: Invalid or missing ADMIN_SECRET', 401);
    }
  }

  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (key !== 'dataset' && key !== 'format') return errorResponse('不支持的导出参数：' + key, 400);
  }
  const dataset = (url.searchParams.get('dataset') || 'sunset_feedback').toLowerCase();
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  if (!['csv', 'json'].includes(format)) return errorResponse('format 仅支持 csv 或 json', 400);

  try {
    const config = await resolveDataset(env.DB, dataset);
    if (!config) return errorResponse('dataset 仅支持 sunset_feedback、prediction_snapshots 或 sunset_observations', 400);
    const exported = await exportRows(env.DB, dataset, config);
    if (exported.error) return exported.error;
    return format === 'csv'
      ? csvResponse(dataset, config.columns, exported.rows)
      : jsonResponse(dataset, exported.rows);
  } catch {
    return errorResponse('导出失败', 500, { dataset });
  }
}
