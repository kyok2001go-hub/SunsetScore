/**
 * Cloudflare Pages Functions - 实况与全量特征回测数据集导出接口
 * 路由：GET /api/export?format=json (或 ?format=csv)
 * 绑定变量：env.DB (D1 数据库)
 * 可选鉴权：env.ADMIN_SECRET (若配置则校验 Authorization: Bearer <SECRET>)
 */

const EXPORT_COLUMNS = [
  // 1. 主键与时间
  'id',
  'query_id',
  'created_at',

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
  'model_version',
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
];

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'D1 database not bound' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  /* 可选安全鉴权 */
  if (env.ADMIN_SECRET) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== env.ADMIN_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or missing ADMIN_SECRET' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') || '2000', 10)));

  try {
    const columnSql = EXPORT_COLUMNS.join(', ');
    const query = await env.DB.prepare(`
      SELECT ${columnSql} FROM sunset_feedback 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(limit).all();

    const rows = query.results || [];

    if (format === 'csv') {
      if (!rows.length) {
        return new Response('\uFEFF' + EXPORT_COLUMNS.join(','), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="sunset_feedback_${Date.now()}.csv"`,
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      const csvLines = [EXPORT_COLUMNS.join(',')];
      for (const row of rows) {
        const line = EXPORT_COLUMNS.map(col => {
          const val = row[col];
          if (val == null) return '';
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('\n') || str.includes('\r') || str.includes('"')
            ? `"${str}"`
            : str;
        }).join(',');
        csvLines.push(line);
      }

      return new Response('\uFEFF' + csvLines.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sunset_feedback_${Date.now()}.csv"`,
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify(rows, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '导出失败: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
