/**
 * Cloudflare Pages Functions - 实况与特征回测数据集导出接口
 * 路由：GET /api/export?format=json (或 ?format=csv)
 * 绑定变量：env.DB (D1 数据库)
 * 可选鉴权：env.ADMIN_SECRET (若配置则校验 Authorization: Bearer <SECRET>)
 */

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
    const query = await env.DB.prepare(`
      SELECT * FROM sunset_feedback 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(limit).all();

    const rows = query.results || [];

    if (format === 'csv') {
      if (!rows.length) {
        return new Response('', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      const headers = Object.keys(rows[0]);
      const csvLines = [headers.join(',')];
      for (const row of rows) {
        const line = headers.map(h => {
          const val = row[h];
          if (val == null) return '';
          const str = String(val).replace(/"/g, '""');
          return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
        }).join(',');
        csvLines.push(line);
      }

      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sunset_feedback_${Date.now()}.csv"`
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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
