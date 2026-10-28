// V2.5.5.8: generates js/satellite_colormap.js from the public GIBS colormap XML (Clean_Longwave_Infrared_Window_Band, v1.3).
// Usage: node tools/satellite/build-colormap.mjs <downloaded cmap.xml> js/satellite_colormap.js   (the output records the source SHA-256)
import fs from 'node:fs';
import crypto from 'node:crypto';
const [src, out] = process.argv.slice(2);
const bytes = fs.readFileSync(src), xml = bytes.toString('utf8');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const main = xml.match(/<ColorMap title="Infrared Brightness Temperature" units="°C">([\s\S]*?)<\/ColorMap>/);
if (!main) throw new Error('main colormap not found');
const entries = [...main[1].matchAll(/<ColorMapEntry rgb="(\d+),(\d+),(\d+)"[^>]*value="\(([^,]+),([^\]\)]+)[\]\)]"/g)].map(m => {
  const lo = Number(m[4]), hi = m[5] === '+INF' ? Number(m[4]) + 1 : Number(m[5]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('bad interval ' + m[0]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round((lo + hi) / 2 * 100) / 100];
});
const keys = new Set(entries.map(e => e[0] * 65536 + e[1] * 256 + e[2]));
if (keys.size !== entries.length) throw new Error('duplicate colours');
if (entries.length !== 238) throw new Error('unexpected entry count ' + entries.length);
const lines = [];
for (let i = 0; i < entries.length; i += 8) lines.push('    ' + entries.slice(i, i + 8).map(e => `[${e.join(',')}]`).join(','));
const js = `/* ============================================================
 * SunsetScore V2.5.5.8 - Band13 红外亮温色表（由 GIBS 色表生成，勿手改）
 * 来源：https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml
 * 源文件 SHA-256：${sha256}
 * 每项为 [r, g, b, 亮温区间中点（°C）]；颜色互不重复；透明像素为无数据。生成脚本：tools/satellite/build-colormap.mjs。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  SS.satelliteColormap = Object.freeze({
    url: 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml',
    sha256: '${sha256}',
    units: 'celsius',
    entries: Object.freeze([
${lines.join(',\n')}
    ])
  });
})(typeof window !== 'undefined' ? window : globalThis);
`;
fs.writeFileSync(out, js);
console.log('entries', entries.length, 'sha256', sha256, 'range', Math.min(...entries.map(e => e[3])), Math.max(...entries.map(e => e[3])));
