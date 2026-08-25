/**
 * Cloudflare Pages Functions - 晚霞实况反馈与特征对存储接口
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

  if (!payload || !payload.query_id || !payload.city || payload.predicted_score == null || !payload.user_rating) {
    return jsonResponse({ success: false, error: '缺少必要的特征或反馈字段 (query_id, city, predicted_score, user_rating)' }, 400);
  }

  /* 客户端 IP 与 User-Agent 脱敏提取 */
  const rawIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
  const userIpHash = await sha256(rawIp + '_ss_salt');
  const clientUa = (request.headers.get('user-agent') || '').slice(0, 200);

  const recordId = 'fb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

  /* 自动建表（确保首次部署即使未手动执行 schema.sql 也能无缝写入） */
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sunset_feedback (
        id TEXT PRIMARY KEY,
        query_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        city TEXT NOT NULL,
        country TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        timezone TEXT,
        sunset_time_local TEXT,
        sunset_azimuth REAL,
        model_version TEXT NOT NULL,
        predicted_score INTEGER NOT NULL,
        predicted_level TEXT NOT NULL,
        baseline_score INTEGER,
        baseline_level TEXT,
        regime_label TEXT,
        sky_evolution_state TEXT,
        sky_evolution_factor REAL,
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
        layer_wind_850_speed REAL,
        layer_wind_850_dir REAL,
        visibility_km REAL,
        precipitation REAL,
        user_rating TEXT NOT NULL,
        user_rating_label TEXT NOT NULL,
        user_comment TEXT,
        user_ip_hash TEXT,
        client_ua TEXT
      )
    `).run();
  } catch (tableErr) {
    // 忽略已存在错误
  }

  /* 频次防刷校验：同一 IP 10 分钟内对相同城市最多提交 2 次 */
  try {
    const rateCheck = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM sunset_feedback 
      WHERE user_ip_hash = ? AND city = ? AND created_at > datetime('now', '-10 minutes')
    `).bind(userIpHash, payload.city).first();

    if (rateCheck && rateCheck.count >= 3) {
      return jsonResponse({
        success: false,
        error: '提交过于频繁，请稍后再试。'
      }, 429);
    }
  } catch (rateErr) {
    // 降级继续
  }

  /* 执行参数化 SQL 写入 */
  try {
    const insertStmt = env.DB.prepare(`
      INSERT INTO sunset_feedback (
        id, query_id, city, country, latitude, longitude, timezone, sunset_time_local, sunset_azimuth,
        model_version, predicted_score, predicted_level, baseline_score, baseline_level,
        regime_label, sky_evolution_state, sky_evolution_factor,
        comp_sky_canvas, comp_horizon, comp_illumination, comp_atmosphere, comp_weather,
        cloud_cover_total, cloud_cover_low, cloud_cover_mid, cloud_cover_high,
        corridor_cloud_mid, corridor_cloud_high, anti_sunset_score,
        layer_wind_850_speed, layer_wind_850_dir, visibility_km, precipitation,
        user_rating, user_rating_label, user_comment, user_ip_hash, client_ua
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).bind(
      recordId,
      String(payload.query_id),
      String(payload.city),
      payload.country ? String(payload.country) : null,
      Number(payload.latitude) || 0,
      Number(payload.longitude) || 0,
      payload.timezone ? String(payload.timezone) : null,
      payload.sunset_time_local ? String(payload.sunset_time_local) : null,
      Number(payload.sunset_azimuth) || 0,
      payload.model_version ? String(payload.model_version) : '2.2.0',
      Math.round(Number(payload.predicted_score) || 0),
      String(payload.predicted_level || '一般'),
      payload.baseline_score != null ? Math.round(Number(payload.baseline_score)) : null,
      payload.baseline_level ? String(payload.baseline_level) : null,
      payload.regime_label ? String(payload.regime_label) : null,
      payload.sky_evolution_state ? String(payload.sky_evolution_state) : null,
      payload.sky_evolution_factor != null ? Number(payload.sky_evolution_factor) : null,
      payload.comp_sky_canvas != null ? Math.round(Number(payload.comp_sky_canvas)) : null,
      payload.comp_horizon != null ? Math.round(Number(payload.comp_horizon)) : null,
      payload.comp_illumination != null ? Math.round(Number(payload.comp_illumination)) : null,
      payload.comp_atmosphere != null ? Math.round(Number(payload.comp_atmosphere)) : null,
      payload.comp_weather != null ? Math.round(Number(payload.comp_weather)) : null,
      payload.cloud_cover_total != null ? Math.round(Number(payload.cloud_cover_total)) : null,
      payload.cloud_cover_low != null ? Math.round(Number(payload.cloud_cover_low)) : null,
      payload.cloud_cover_mid != null ? Math.round(Number(payload.cloud_cover_mid)) : null,
      payload.cloud_cover_high != null ? Math.round(Number(payload.cloud_cover_high)) : null,
      payload.corridor_cloud_mid != null ? Number(payload.corridor_cloud_mid) : null,
      payload.corridor_cloud_high != null ? Number(payload.corridor_cloud_high) : null,
      payload.anti_sunset_score != null ? Math.round(Number(payload.anti_sunset_score)) : null,
      payload.layer_wind_850_speed != null ? Number(payload.layer_wind_850_speed) : null,
      payload.layer_wind_850_dir != null ? Number(payload.layer_wind_850_dir) : null,
      payload.visibility_km != null ? Number(payload.visibility_km) : null,
      payload.precipitation != null ? Number(payload.precipitation) : null,
      String(payload.user_rating),
      String(payload.user_rating_label || payload.user_rating),
      payload.user_comment ? String(payload.user_comment).slice(0, 500) : null,
      userIpHash,
      clientUa
    );

    await insertStmt.run();

    return jsonResponse({
      success: true,
      id: recordId,
      message: '实况反馈与预测特征已成功同步至 D1 数据库'
    });
  } catch (dbErr) {
    return jsonResponse({
      success: false,
      error: '写入 D1 数据库失败: ' + (dbErr && dbErr.message ? dbErr.message : String(dbErr))
    }, 500);
  }
}
