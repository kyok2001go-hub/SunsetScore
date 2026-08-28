/* GCJ-02 city coordinates -> approximate WGS84 for the existing forecast/solar grid.
 * Only applied to mainland QWeather rows, never to Open-Meteo or typed coordinates.
 * Numerical inverse of the conventional GCJ offset; not a survey-grade conversion.
 */
function offset(lat, lon) {
  const x = lon - 105, y = lat - 35, pi = Math.PI;
  let dy = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  let dx = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  const wave = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  dy += wave + (20 * Math.sin(y * pi) + 40 * Math.sin(y * pi / 3)) * 2 / 3
    + (160 * Math.sin(y * pi / 12) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  dx += wave + (20 * Math.sin(x * pi) + 40 * Math.sin(x * pi / 3)) * 2 / 3
    + (150 * Math.sin(x * pi / 12) + 300 * Math.sin(x * pi / 30)) * 2 / 3;
  const rad = lat * pi / 180, a = 6378245, e2 = 0.006693421622965943;
  const magic = 1 - e2 * Math.sin(rad) ** 2, sqrt = Math.sqrt(magic);
  return [dy * 180 / ((a * (1 - e2)) / (magic * sqrt) * pi),
    dx * 180 / (a / sqrt * Math.cos(rad) * pi)];
}

export function gcj02ToWgs84(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat < 0.8293 || lat > 55.8271 || lon < 72.004 || lon > 137.8347) return { latitude: lat, longitude: lon };
  let latitude = lat, longitude = lon;
  for (let i = 0; i < 5; i++) {
    const [dy, dx] = offset(latitude, longitude);
    latitude = lat - dy;
    longitude = lon - dx;
  }
  return { latitude, longitude };
}
