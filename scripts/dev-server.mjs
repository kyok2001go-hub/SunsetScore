import { fetchWithDeadline } from '../server/network.js';
import { handleGeo, geoQuery } from '../server/qweather-geo.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const port = Number(process.env.SUNSETSCORE_DEV_PORT || 8788);
const host = process.env.SUNSETSCORE_DEV_HOST || '127.0.0.1';
const keyFile = path.join(projectRoot, 'QweatherKey.txt');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

export function parseQWeatherConfig(text) {
  const hostMatch = text.match(/^\s*API\s+HOST\s*:\s*(\S+)\s*$/im);
  const keyMatch = text.match(/^\s*API\s+KEY\s*:\s*(\S+)\s*$/im);
  const apiHost = hostMatch && hostMatch[1].trim();
  const apiKey = keyMatch && keyMatch[1].trim();
  if (!apiHost || !apiKey) {
    throw new Error('QweatherKey.txt 必须包含 API HOST 和 API KEY 两行');
  }
  if (!/^[a-z0-9.-]+$/i.test(apiHost)) throw new Error('QweatherKey.txt 中的 API HOST 无效');
  return { apiHost, apiKey };
}

async function proxyQWeather(requestUrl, res) {
  const controller = new AbortController();
  function onClose() { if (!res.writableEnded) controller.abort(); }
  res.once('close', onClose);
  const lat = Number(requestUrl.searchParams.get('lat'));
  const lon = Number(requestUrl.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    json(res, 400, { error: 'Invalid coordinates' });
    return;
  }

  let config;
  try {
    config = parseQWeatherConfig(await readFile(keyFile, 'utf8'));
  } catch (error) {
    json(res, 503, { error: error instanceof Error ? error.message : 'QWeather local config unavailable' });
    return;
  }

  const upstream = new URL(`https://${config.apiHost}/v7/minutely/5m`);
  upstream.searchParams.set('location', `${lon.toFixed(2)},${lat.toFixed(2)}`);

  try {
    const upstreamResponse = await fetchWithDeadline(upstream, {
      headers: { 'X-QW-Api-Key': config.apiKey }, redirect: 'error'
    }, { signal: controller.signal });
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    res.writeHead(upstreamResponse.status, {
      'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch (error) {
    console.error('QWeather upstream request failed:', error instanceof Error ? error.message : String(error));
    if (!res.destroyed) json(res, error.name === 'TimeoutError' ? 504 : 502, { error: 'QWeather upstream unavailable' });
  } finally {
    res.removeListener('close', onClose);
  }
}

function isBlockedPath(pathname) {
  const normalized = pathname.toLowerCase();
  return normalized === '/qweatherkey.txt' ||
    normalized.startsWith('/.git') ||
    normalized.startsWith('/.dev.vars') ||
    normalized.startsWith('/.env');
}

async function proxyGeocoding(requestUrl, req, res) {
  if (!geoQuery(requestUrl)) { json(res, 400, { error: 'Invalid city query' }); return; }
  const controller = new AbortController();
  function onClose() { if (!res.writableEnded) controller.abort(); }
  res.once('close', onClose);
  try {
    const config = parseQWeatherConfig(await readFile(keyFile, 'utf8'));
    const response = await handleGeo(new Request(requestUrl, { method: req.method, signal: controller.signal }),
      { QWEATHER_API_KEY: config.apiKey, QWEATHER_HOST: config.apiHost });
    const body = Buffer.from(await response.arrayBuffer());
    if (!res.destroyed) {
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    }
  } catch {
    if (!res.destroyed) json(res, 503, { error: 'QWeather local city config unavailable' });
  } finally { res.removeListener('close', onClose); }
}

async function serveStatic(requestUrl, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (isBlockedPath(pathname)) {
    res.writeHead(404).end('Not Found');
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(projectRoot, `.${requestedPath}`);
  const relative = path.relative(projectRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  if (requestUrl.pathname === '/api/geocoding') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end('Method Not Allowed'); return; }
    await proxyGeocoding(requestUrl, req, res);
    return;
  }
  if (requestUrl.pathname === '/api/qweather') {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end('Method Not Allowed');
      return;
    }
    await proxyQWeather(requestUrl, res);
    return;
  }
  await serveStatic(requestUrl, res);
});

server.listen(port, host, () => {
  console.log(`SunsetScore V2.3.5 local server: http://${host}:${port}`);
  console.log('QWeather key source: QweatherKey.txt (server-side only)');
});

