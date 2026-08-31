/**
 * SunsetScore V2.3 - Cloudflare Pages Functions 反馈接口
 * 路由：POST /api/feedback；绑定：env.DB (D1)
 * 数据库结构由 migrations 管理，本处理器不执行 DDL。
 */
import { feedbackColumns, feedbackEpochSql } from '../../server/feedback-db.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

async function sha256(str) {
  const data = new TextEncoder().encode(str || 'anonymous');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

function normalizeTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone || /^(UTC|GMT)[+-]/i.test(timezone)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch (error) {
    return 'UTC';
  }
}

function formatDateTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimezone(timeZone),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n);
}

function textOrNull(value, maxLength = 500) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, maxLength); } catch (error) { return null; }
  }
  return String(value).slice(0, maxLength);
}

function booleanInteger(value, fallback = 0) {
  return value == null ? fallback : (value ? 1 : 0);
}

const PAYLOAD_FIELDS = [
  ['query_id', (p) => textOrNull(p.query_id, 120) || 'n/a'],
  ['city', (p) => String(p.city)],
  ['country', (p) => textOrNull(p.country, 120)],
  ['admin1', (p) => textOrNull(p.admin1, 120)],
  ['latitude', (p) => numberOrNull(p.latitude) ?? 0],
  ['longitude', (p) => numberOrNull(p.longitude) ?? 0],
  ['sunset_time_local', (p) => textOrNull(p.sunset_time_local, 40)],
  ['sunset_azimuth', (p) => numberOrNull(p.sunset_azimuth)],
  ['twilight_minutes', (p) => integerOrNull(p.twilight_minutes)],
  ['best_viewing_window', (p) => textOrNull(p.best_viewing_window, 120)],
  ['app_version', (p) => textOrNull(p.app_version, 30) || '2.3.7'],
  ['model_version', (p) => textOrNull(p.model_version, 30) || '2.3.7'],
  ['schema_version', (p) => integerOrNull(p.schema_version) ?? 3],
  ['predicted_score', (p) => integerOrNull(p.predicted_score) ?? 0],
  ['predicted_level', (p) => textOrNull(p.predicted_level, 30) || '一般'],
  ['baseline_score', (p) => integerOrNull(p.baseline_score)],
  ['baseline_level', (p) => textOrNull(p.baseline_level, 30)],
  ['regime_label', (p) => textOrNull(p.regime_label, 80)],
  ['regime_strength', (p) => numberOrNull(p.regime_strength)],
  ['sky_evolution_state', (p) => textOrNull(p.sky_evolution_state, 40)],
  ['sky_evolution_factor', (p) => numberOrNull(p.sky_evolution_factor)],
  ['gw_factor', (p) => numberOrNull(p.gw_factor)],
  ['comp_sky_canvas', (p) => integerOrNull(p.comp_sky_canvas)],
  ['comp_horizon', (p) => integerOrNull(p.comp_horizon)],
  ['comp_illumination', (p) => integerOrNull(p.comp_illumination)],
  ['comp_atmosphere', (p) => integerOrNull(p.comp_atmosphere)],
  ['comp_weather', (p) => integerOrNull(p.comp_weather)],
  ['cloud_cover_total', (p) => integerOrNull(p.cloud_cover_total) ?? 0],
  ['cloud_cover_low', (p) => integerOrNull(p.cloud_cover_low) ?? 0],
  ['cloud_cover_mid', (p) => integerOrNull(p.cloud_cover_mid) ?? 0],
  ['cloud_cover_high', (p) => integerOrNull(p.cloud_cover_high) ?? 0],
  ['corridor_cloud_mid', (p) => numberOrNull(p.corridor_cloud_mid)],
  ['corridor_cloud_high', (p) => numberOrNull(p.corridor_cloud_high)],
  ['anti_sunset_score', (p) => integerOrNull(p.anti_sunset_score)],
  ['spatial_variance', (p) => numberOrNull(p.spatial_variance)],
  ['cloud_continuity', (p) => integerOrNull(p.cloud_continuity)],
  ['aod', (p) => numberOrNull(p.aod)],
  ['pm25', (p) => numberOrNull(p.pm25)],
  ['humidity', (p) => numberOrNull(p.humidity)],
  ['surface_pressure', (p) => numberOrNull(p.surface_pressure)],
  ['visibility_km', (p) => numberOrNull(p.visibility_km)],
  ['precipitation', (p) => numberOrNull(p.precipitation) ?? 0],
  ['layer_wind_850_speed', (p) => numberOrNull(p.layer_wind_850_speed)],
  ['layer_wind_850_dir', (p) => numberOrNull(p.layer_wind_850_dir)],
  ['layer_wind_700_speed', (p) => numberOrNull(p.layer_wind_700_speed)],
  ['layer_wind_700_dir', (p) => numberOrNull(p.layer_wind_700_dir)],
  ['layer_wind_500_speed', (p) => numberOrNull(p.layer_wind_500_speed)],
  ['layer_wind_500_dir', (p) => numberOrNull(p.layer_wind_500_dir)],
  ['is_real_sounding', (p) => booleanInteger(p.is_real_sounding, 1)],
  ['open_prob_30m', (p) => numberOrNull(p.open_prob_30m)],
  ['open_prob_60m', (p) => numberOrNull(p.open_prob_60m)],
  ['open_prob_120m', (p) => numberOrNull(p.open_prob_120m)],
  ['arrival_risk_30m', (p) => numberOrNull(p.arrival_risk_30m)],
  ['arrival_risk_60m', (p) => numberOrNull(p.arrival_risk_60m)],
  ['tile_radar_available', (p) => booleanInteger(p.tile_radar_available)],
  ['tile_sat_available', (p) => booleanInteger(p.tile_sat_available)],
  ['dyn_weight_canvas', (p) => numberOrNull(p.dyn_weight_canvas)],
  ['dyn_weight_horizon', (p) => numberOrNull(p.dyn_weight_horizon)],
  ['dyn_weight_illum', (p) => numberOrNull(p.dyn_weight_illum)],
  ['dyn_weight_atmo', (p) => numberOrNull(p.dyn_weight_atmo)],
  ['dyn_weight_weather', (p) => numberOrNull(p.dyn_weight_weather)],
  ['user_rating', (p) => String(p.user_rating)],
  ['user_rating_label', (p) => textOrNull(p.user_rating_label, 80) || String(p.user_rating)],
  ['user_comment', (p) => textOrNull(p.user_comment, 500)],
  ['raw_snapshot_json', (p) => textOrNull(p.raw_snapshot_json ?? p.raw_snapshot, 250000)]
];

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  if (!env.DB) return jsonResponse({ success: false, error: 'D1 数据库未绑定 (env.DB is missing)' }, 500);

  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ success: false, error: '无效的 JSON 请求体' }, 400);
  }
  if (!payload || !payload.user_rating || !payload.city) {
    return jsonResponse({ success: false, error: '缺少必填字段：city 与 user_rating 为必填项' }, 400);
  }
  if (!['great', 'good', 'fair', 'poor'].includes(payload.user_rating)) {
    return jsonResponse({ success: false, error: '请选择实际晚霞等级：极佳彩霞、普通有霞、仅微霞或完全无霞' }, 400);
  }

  const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
  const userIpHash = await sha256(rawIp + '_ss_salt');
  const clientUa = (request.headers.get('user-agent') || '').slice(0, 250);
  const now = new Date();
  const nowEpoch = now.valueOf();
  const timezone = normalizeTimezone(payload.timezone);
  const createdAtUtc = now.toISOString();
  const createdAtLocal = formatDateTimeZone(now, timezone);
  const createdAtCompatibility = formatDateTimeZone(now, 'Asia/Shanghai');
  const recordId = 'fb_' + nowEpoch + '_' + crypto.randomUUID();

  let availableColumns;
  try {
    availableColumns = await feedbackColumns(env.DB);
    const epochSql = feedbackEpochSql(availableColumns);
    const rateCheck = await env.DB.prepare(`
      SELECT ${epochSql} AS created_at_epoch FROM sunset_feedback
      WHERE user_ip_hash = ? AND city = ? AND (${epochSql}) > ?
      ORDER BY ${epochSql} DESC LIMIT 1
    `).bind(userIpHash, String(payload.city), nowEpoch - 30 * 60 * 1000).first();
    if (rateCheck) {
      return jsonResponse({ success: false, cooldown: true, error: '为保证数据质量，30 分钟内限提交一次实况反馈，请稍后再试。' }, 429);
    }
  } catch (error) {
    console.error(JSON.stringify({ message: 'feedback rate limit query failed', error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ success: false, error: '反馈数据库暂不可用，请检查 DB 绑定及 sunset_feedback 表后重试' }, 503);
  }

  const systemColumns = ['id', 'created_at', 'created_at_local', 'created_at_epoch', 'created_at_utc', 'timezone', 'user_ip_hash', 'client_ua'];
  const systemValues = [recordId, createdAtCompatibility, createdAtLocal, nowEpoch, createdAtUtc, timezone, userIpHash, clientUa];
  const payloadColumns = PAYLOAD_FIELDS.map(([name]) => name);
  const payloadValues = PAYLOAD_FIELDS.map(([, convert]) => convert(payload));
  const allColumns = systemColumns.concat(payloadColumns);
  const allValues = systemValues.concat(payloadValues);
  const columns = allColumns.filter((name) => availableColumns.has(name));
  const values = allValues.filter((value, index) => availableColumns.has(allColumns[index]));
  const placeholders = columns.map(() => '?').join(', ');

  try {
    await env.DB.prepare(`INSERT INTO sunset_feedback (${columns.join(', ')}) VALUES (${placeholders})`).bind(...values).run();
    return jsonResponse({ success: true, id: recordId, message: '实况反馈已同步至 D1 数据库' });
  } catch (error) {
    console.error(JSON.stringify({ message: 'feedback insert failed', error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ success: false, error: '写入 D1 数据库失败' }, 500);
  }
}
