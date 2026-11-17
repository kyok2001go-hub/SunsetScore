// V2.5.5.15 satellite vs NWP single-level mid/high cloud (bypass:validate --raw). Same definitions as the V2.5.5.13
// diagnostic §2.3: sunset sector ±30°, near zone 0–100 km (CENTER + 50/100 km nodes; satellite bands 0–50 + 50–100 km),
// far zone 100–250 km (200 km nodes; satellite band 100–250 km); latest OK frame; Replay max(mid, high) interpolated
// to the frame time. Label-free: reads only Replay inputs, never Observations.
// PRD: ref_docs/PRD/V2.5.5.15--旁路质量报告修正与气压层云量核查方案.md §3.2
const round = (value, digits = 3) => value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

export const latestOkFrame = shadow => shadow && [...shadow.frames].reverse().find(f => f.status === 'OK' && f.summary) || null;

export function seriesAt(times, values, ms) {
  const t = times.map(Date.parse);
  for (let i = 0; i < t.length - 1; i++) {
    if (ms >= t[i] && ms <= t[i + 1]) {
      const a = values[i], b = values[i + 1];
      if (a == null || b == null) return a ?? b ?? null;
      return a + (b - a) * (ms - t[i]) / (t[i + 1] - t[i]);
    }
  }
  return null;
}

const inSector = (node, azimuth) => node.direction === 'CENTER' || angDiff(node.azimuth, azimuth) <= 30;
// Node geometry comes from the Replay's 33 cloud-field nodes (same keys, directions and distances as the bypass grid),
// because V2.5.5.15 objects no longer carry grid_nodes.
export const zoneKeys = (nodes, azimuth, zone) => new Set(nodes
  .filter(n => inSector(n, azimuth) && (zone === 'near' ? n.distance_km <= 100 : n.distance_km === 200)).map(n => n.key));

export function satelliteZone(frame, zone) {
  const bands = frame.summary.bands.filter(b => zone === 'near' ? b.band_km[1] <= 100 : b.band_km[0] >= 100);
  const weight = bands.reduce((s, b) => s + b.valid, 0);
  return weight ? bands.reduce((s, b) => s + b.frac_cloud_v1 * b.valid, 0) / weight : null;
}

export function replayMidHigh(replay, keys, ms) {
  const values = replay.nwp.nodes.filter(n => keys.has(n.key)).map(n => {
    const mid = seriesAt(n.time_utc, n.variables.cloud_cover_mid || [], ms), high = seriesAt(n.time_utc, n.variables.cloud_cover_high || [], ms);
    return mid == null && high == null ? null : Math.max(mid ?? 0, high ?? 0) / 100;
  }).filter(v => v != null);
  return values.length ? mean(values) : null;
}

function rank(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return ranks;
}
function spearman(x, y) {
  if (x.length < 10) return null;
  const a = rank(x), b = rank(y), ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; });
  return da && db ? n / Math.sqrt(da * db) : null;
}

export function contrastStats(pairs) {
  if (!pairs.length) return { n: 0 };
  const diff = pairs.map(p => p.sat - p.nwp), share = f => round(pairs.filter(f).length / pairs.length);
  return { n: pairs.length, mean_satellite: round(mean(pairs.map(p => p.sat))), mean_nwp: round(mean(pairs.map(p => p.nwp))),
    mean_diff: round(mean(diff)), mae: round(mean(diff.map(Math.abs))), spearman: round(spearman(pairs.map(p => p.sat), pairs.map(p => p.nwp))),
    severe_ratio: share(p => Math.abs(p.sat - p.nwp) >= 0.5), nwp_cloudy_sat_clear: share(p => p.nwp >= 0.5 && p.sat < 0.2),
    nwp_clear_sat_cloudy: share(p => p.nwp < 0.2 && p.sat >= 0.5) };
}

/** items: [{ payload, replay }] for VALID objects whose Replay hash matched. Deterministic. */
export function singleLevelContrast(items) {
  const pairs = { near: [], far: [] };
  let skipped = 0;
  for (const { payload, replay } of items) {
    const frame = payload.bypass_schema_version >= 2 && payload.satellite_shadow?.status === 'OK' ? latestOkFrame(payload.satellite_shadow) : null;
    if (!frame) { skipped++; continue; }
    const ms = Date.parse(frame.time_actual_utc || frame.time_utc);
    for (const zone of ['near', 'far']) {
      const sat = satelliteZone(frame, zone), nwp = replayMidHigh(replay, zoneKeys(replay.nwp.nodes, payload.sunset_azimuth_deg, zone), ms);
      if (sat != null && nwp != null) pairs[zone].push({ sat, nwp });
    }
  }
  return { definition: 'V2.5.5.13_SECTION_2_3', objects: items.length, without_ok_frame: skipped,
    near: contrastStats(pairs.near), far: contrastStats(pairs.far) };
}
