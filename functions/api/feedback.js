/**
 * Cloudflare Pages Functions - 晚霞实况反馈与全维度物理特征存储接口
 * 路由：POST /api/feedback
 * 绑定变量：env.DB (Cloudflare D1 实例)
 */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

/**
 * 将字符串哈希为安全脱敏的十六进制 (SHA-256)
 */
async function sha256(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str || 'anonymous');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/**
 * 获取指定时区的格式化时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
function formatDateTimeZone(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const map = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  } catch (e) {
    // 兜底为 UTC+8
    const d = new Date(date.getTime() + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
}

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
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({
      success: false,
      error: 'D1 数据库未绑定 (env.DB is missing)。请在 Cloudflare Pages 设置中将 D1 sunset-db 绑定为 DB。'
    }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, error: '无效的 JSON 请求体' }, 400);
  }

  if (!payload || !payload.user_rating || !payload.city) {
    return jsonResponse({
      success: false,
      error: '缺少必填字段：city 与 user_rating 为必填项'
    }, 400);
  }

  /* 客户端 IP 与 User-Agent 脱敏提取 */
  const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
  const userIpHash = await sha256(rawIp + '_ss_salt');
  const clientUa = (request.headers.get('user-agent') || '').slice(0, 250);

  const recordId = 'fb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const now = new Date();
  const createdAtBeijing = formatDateTimeZone(now, 'Asia/Shanghai');
  let createdAtLocal = createdAtBeijing;
  if (payload.timezone) {
    createdAtLocal = formatDateTimeZone(now, payload.timezone);
  }

  /* 1. 自动建表（确保首次部署即使未手动执行 schema.sql 也能无缝写入） */
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sunset_feedback (
        id TEXT PRIMARY KEY,
        query_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_local TEXT,
        city TEXT NOT NULL,
        country TEXT,
        admin1 TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        timezone TEXT,
        sunset_time_local TEXT,
        sunset_azimuth REAL,
        twilight_minutes INTEGER,
        best_viewing_window TEXT,
        model_version TEXT NOT NULL,
        predicted_score INTEGER NOT NULL,
        predicted_level TEXT NOT NULL,
        baseline_score INTEGER,
        baseline_level TEXT,
        regime_label TEXT,
        regime_strength REAL,
        sky_evolution_state TEXT,
        sky_evolution_factor REAL,
        gw_factor REAL,
        comp_sky_canvas INTEGER,
        comp_horizon INTEGER,
        comp_illumination INTEGER,
        comp_atmosphere INTEGER,
        comp_weather INTEGER,
        cloud_cover_total INTEGER,
        cloud_cover_low INTEGER,
        cloud_cover_mid INTEGER,
        cloud_cover_high INTEGER,
        corridor_cloud_mid REAL,
        corridor_cloud_high REAL,
        anti_sunset_score INTEGER,
        spatial_variance REAL,
        cloud_continuity INTEGER,
        aod REAL,
        pm25 REAL,
        humidity REAL,
        surface_pressure REAL,
        visibility_km REAL,
        precipitation REAL,
        layer_wind_850_speed REAL,
        layer_wind_850_dir REAL,
        layer_wind_700_speed REAL,
        layer_wind_700_dir REAL,
        layer_wind_500_speed REAL,
        layer_wind_500_dir REAL,
        is_real_sounding INTEGER DEFAULT 1,
        open_prob_30m REAL,
        open_prob_60m REAL,
        open_prob_120m REAL,
        arrival_risk_30m REAL,
        arrival_risk_60m REAL,
        tile_radar_available INTEGER DEFAULT 0,
        tile_sat_available INTEGER DEFAULT 0,
        dyn_weight_canvas REAL,
        dyn_weight_horizon REAL,
        dyn_weight_illum REAL,
        dyn_weight_atmo REAL,
        dyn_weight_weather REAL,
        user_rating TEXT NOT NULL,
        user_rating_label TEXT NOT NULL,
        user_comment TEXT,
        user_ip_hash TEXT,
        client_ua TEXT,
        raw_snapshot_json TEXT
      )
    `).run();
  } catch (tableErr) {
    // 忽略
  }

  /* 2. 自动热迁移（对现有线上旧表自动增补新列，保证数据无损平滑升级） */
  const MIGRATION_COLUMNS = [
    ['created_at_local', 'TEXT'],
    ['admin1', 'TEXT'],
    ['twilight_minutes', 'INTEGER'],
    ['best_viewing_window', 'TEXT'],
    ['regime_strength', 'REAL'],
    ['gw_factor', 'REAL'],
    ['spatial_variance', 'REAL'],
    ['cloud_continuity', 'INTEGER'],
    ['aod', 'REAL'],
    ['pm25', 'REAL'],
    ['humidity', 'REAL'],
    ['surface_pressure', 'REAL'],
    ['layer_wind_700_speed', 'REAL'],
    ['layer_wind_700_dir', 'REAL'],
    ['layer_wind_500_speed', 'REAL'],
    ['layer_wind_500_dir', 'REAL'],
    ['is_real_sounding', 'INTEGER DEFAULT 1'],
    ['open_prob_30m', 'REAL'],
    ['open_prob_60m', 'REAL'],
    ['open_prob_120m', 'REAL'],
    ['arrival_risk_30m', 'REAL'],
    ['arrival_risk_60m', 'REAL'],
    ['tile_radar_available', 'INTEGER DEFAULT 0'],
    ['tile_sat_available', 'INTEGER DEFAULT 0'],
    ['dyn_weight_canvas', 'REAL'],
    ['dyn_weight_horizon', 'REAL'],
    ['dyn_weight_illum', 'REAL'],
    ['dyn_weight_atmo', 'REAL'],
    ['dyn_weight_weather', 'REAL'],
    ['raw_snapshot_json', 'TEXT']
  ];

  for (const [colName, colDef] of MIGRATION_COLUMNS) {
    try {
      await env.DB.prepare(`ALTER TABLE sunset_feedback ADD COLUMN ${colName} ${colDef}`).run();
    } catch (e) {
      // 若列已存在，SQLite 抛出 duplicate column name，安全忽略
    }
  }

  /* 3. 频次防刷校验：同一 IP 30 分钟内对相同城市仅限提交 1 次 */
  try {
    const rateCheck = await env.DB.prepare(`
      SELECT created_at FROM sunset_feedback 
      WHERE user_ip_hash = ? AND city = ? AND created_at > datetime('now', '-30 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).bind(userIpHash, payload.city).first();

    if (rateCheck) {
      return jsonResponse({
        success: false,
        cooldown: true,
        error: '为保证数据质量，30 分钟内限提交一次实况反馈，请稍后再试。'
      }, 429);
    }
  } catch (rateErr) {
    // 降级继续
  }

  /* 4. 序列化原始快照 JSON (若存在) */
  let rawJsonStr = null;
  if (payload.raw_snapshot) {
    try {
      rawJsonStr = typeof payload.raw_snapshot === 'string' ? payload.raw_snapshot : JSON.stringify(payload.raw_snapshot);
    } catch (jErr) {}
  } else if (payload.raw_snapshot_json) {
    rawJsonStr = String(payload.raw_snapshot_json);
  }

  /* 5. 执行全字段参数化 SQL 写入 */
  try {
    const insertStmt = env.DB.prepare(`
      INSERT INTO sunset_feedback (
        id, query_id, created_at, created_at_local, city, country, admin1, latitude, longitude, timezone, sunset_time_local, sunset_azimuth, twilight_minutes, best_viewing_window,
        model_version, predicted_score, predicted_level, baseline_score, baseline_level, regime_label, regime_strength, sky_evolution_state, sky_evolution_factor, gw_factor,
        comp_sky_canvas, comp_horizon, comp_illumination, comp_atmosphere, comp_weather, cloud_cover_total, cloud_cover_low, cloud_cover_mid, cloud_cover_high, corridor_cloud_mid, corridor_cloud_high, anti_sunset_score, spatial_variance, cloud_continuity,
        aod, pm25, humidity, surface_pressure, visibility_km, precipitation,
        layer_wind_850_speed, layer_wind_850_dir, layer_wind_700_speed, layer_wind_700_dir, layer_wind_500_speed, layer_wind_500_dir, is_real_sounding,
        open_prob_30m, open_prob_60m, open_prob_120m, arrival_risk_30m, arrival_risk_60m, tile_radar_available, tile_sat_available,
        dyn_weight_canvas, dyn_weight_horizon, dyn_weight_illum, dyn_weight_atmo, dyn_weight_weather,
        user_rating, user_rating_label, user_comment, user_ip_hash, client_ua,
        raw_snapshot_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?
      )
    `).bind(
      recordId,
      payload.query_id ? String(payload.query_id) : 'n/a',
      createdAtBeijing,
      createdAtLocal,
      String(payload.city),
      payload.country ? String(payload.country) : null,
      payload.admin1 ? String(payload.admin1) : null,
      Number(payload.latitude) || 0,
      Number(payload.longitude) || 0,
      payload.timezone ? String(payload.timezone) : null,
      payload.sunset_time_local ? String(payload.sunset_time_local) : null,
      payload.sunset_azimuth != null ? Number(payload.sunset_azimuth) : null,
      payload.twilight_minutes != null ? Math.round(Number(payload.twilight_minutes)) : null,
      payload.best_viewing_window ? String(payload.best_viewing_window) : null,
      payload.model_version ? String(payload.model_version) : '2.2.2',
      Math.round(Number(payload.predicted_score) || 0),
      String(payload.predicted_level || '一般'),
      payload.baseline_score != null ? Math.round(Number(payload.baseline_score)) : null,
      payload.baseline_level ? String(payload.baseline_level) : null,
      payload.regime_label ? String(payload.regime_label) : null,
      payload.regime_strength != null ? Number(payload.regime_strength) : null,
      payload.sky_evolution_state ? String(payload.sky_evolution_state) : null,
      payload.sky_evolution_factor != null ? Number(payload.sky_evolution_factor) : null,
      payload.gw_factor != null ? Number(payload.gw_factor) : null,
      payload.comp_sky_canvas != null ? Math.round(Number(payload.comp_sky_canvas)) : null,
      payload.comp_horizon != null ? Math.round(Number(payload.comp_horizon)) : null,
      payload.comp_illumination != null ? Math.round(Number(payload.comp_illumination)) : null,
      payload.comp_atmosphere != null ? Math.round(Number(payload.comp_atmosphere)) : null,
      payload.comp_weather != null ? Math.round(Number(payload.comp_weather)) : null,
      payload.cloud_cover_total != null ? Math.round(Number(payload.cloud_cover_total)) : 0,
      payload.cloud_cover_low != null ? Math.round(Number(payload.cloud_cover_low)) : 0,
      payload.cloud_cover_mid != null ? Math.round(Number(payload.cloud_cover_mid)) : 0,
      payload.cloud_cover_high != null ? Math.round(Number(payload.cloud_cover_high)) : 0,
      payload.corridor_cloud_mid != null ? Number(payload.corridor_cloud_mid) : 0,
      payload.corridor_cloud_high != null ? Number(payload.corridor_cloud_high) : 0,
      payload.anti_sunset_score != null ? Math.round(Number(payload.anti_sunset_score)) : null,
      payload.spatial_variance != null ? Number(payload.spatial_variance) : null,
      payload.cloud_continuity != null ? Math.round(Number(payload.cloud_continuity)) : null,
      payload.aod != null ? Number(payload.aod) : null,
      payload.pm25 != null ? Number(payload.pm25) : null,
      payload.humidity != null ? Number(payload.humidity) : null,
      payload.surface_pressure != null ? Number(payload.surface_pressure) : null,
      payload.visibility_km != null ? Number(payload.visibility_km) : null,
      payload.precipitation != null ? Number(payload.precipitation) : 0,
      payload.layer_wind_850_speed != null ? Number(payload.layer_wind_850_speed) : null,
      payload.layer_wind_850_dir != null ? Number(payload.layer_wind_850_dir) : null,
      payload.layer_wind_700_speed != null ? Number(payload.layer_wind_700_speed) : null,
      payload.layer_wind_700_dir != null ? Number(payload.layer_wind_700_dir) : null,
      payload.layer_wind_500_speed != null ? Number(payload.layer_wind_500_speed) : null,
      payload.layer_wind_500_dir != null ? Number(payload.layer_wind_500_dir) : null,
      payload.is_real_sounding != null ? (payload.is_real_sounding ? 1 : 0) : 1,
      payload.open_prob_30m != null ? Number(payload.open_prob_30m) : null,
      payload.open_prob_60m != null ? Number(payload.open_prob_60m) : null,
      payload.open_prob_120m != null ? Number(payload.open_prob_120m) : null,
      payload.arrival_risk_30m != null ? Number(payload.arrival_risk_30m) : null,
      payload.arrival_risk_60m != null ? Number(payload.arrival_risk_60m) : null,
      payload.tile_radar_available != null ? (payload.tile_radar_available ? 1 : 0) : 0,
      payload.tile_sat_available != null ? (payload.tile_sat_available ? 1 : 0) : 0,
      payload.dyn_weight_canvas != null ? Number(payload.dyn_weight_canvas) : null,
      payload.dyn_weight_horizon != null ? Number(payload.dyn_weight_horizon) : null,
      payload.dyn_weight_illum != null ? Number(payload.dyn_weight_illum) : null,
      payload.dyn_weight_atmo != null ? Number(payload.dyn_weight_atmo) : null,
      payload.dyn_weight_weather != null ? Number(payload.dyn_weight_weather) : null,
      String(payload.user_rating),
      String(payload.user_rating_label || payload.user_rating),
      payload.user_comment ? String(payload.user_comment).slice(0, 500) : null,
      userIpHash,
      clientUa,
      rawJsonStr
    );

    await insertStmt.run();

    return jsonResponse({
      success: true,
      id: recordId,
      message: '实况反馈与全量物理特征已成功同步至 D1 数据库'
    });
  } catch (dbErr) {
    return jsonResponse({
      success: false,
      error: '写入 D1 数据库失败: ' + (dbErr && dbErr.message ? dbErr.message : String(dbErr))
    }, 500);
  }
}
