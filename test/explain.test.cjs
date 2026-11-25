const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.37: prediction explanation regenerated after the final score (js/explain.js); scores unchanged.
// PRD: ref_docs/PRD/V2.5.5.37--预测解读文案修正方案.md

const ROOT = join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const explainSS = () => load(createRuntime(), ['js/config.js', 'js/model_config.js', 'js/explain.js']);
const BASE_WEIGHTS = { skyCanvas: 0.2, horizon: 0.375, illumination: 0.4, atmosphere: 0.025, weather: 0 };

function fixture(overrides = {}) {
  const base = {
    score: 70, base_score: 70, level: '很好', sky_evolution_factor: 1, nowcast_active: false, sky_evolution: null,
    components: { sky_canvas: 90, horizon: 90, illumination: 90, atmosphere: 90, weather: 90 },
    regime: 'PARTLY_CLOUDY', regime_label: '多云间晴', penalty: 0, bonus: 0, horizon_gate: 1, hard_gates: [],
    clear_sky: { horizon_factor: 1, hint: false },
    regime_state: { type: 'PARTLY_CLOUDY', strength: 0.5, transition: 'STABLE', dynamicWeight: { ...BASE_WEIGHTS } },
    data: { visibility_km: 30, aod: 0.25, pm25: 10, humidity: 55, cloud_cover: 50, cloud_low: 5, cloud_mid: 40, cloud_high: 50 },
    twilight_minutes: 35, illumination_data_factor: 1, cloud_structure: { centerCloud: 90 }, sector_openings: { corridor: 90 },
    reasons: [], warnings: []
  };
  const merged = { ...base, ...overrides };
  for (const key of ['components', 'data', 'regime_state', 'clear_sky', 'cloud_structure']) {
    if (overrides[key]) merged[key] = { ...base[key], ...overrides[key] };
  }
  return merged;
}

// 2026-11-25 production query (app 2.5.5.29): score 57, low 0 / mid 0 / high 100, overcast strength 1.
function shanghai() {
  return fixture({
    score: 57, base_score: 57,
    components: { sky_canvas: 42, horizon: 100, illumination: 27, atmosphere: 85, weather: 48 },
    regime: 'OVERCAST', regime_label: '阴天',
    regime_state: { type: 'OVERCAST', strength: 1, dynamicWeight: { skyCanvas: 0.13, horizon: 0.52, illumination: 0.29, atmosphere: 0.02, weather: 0.05 } },
    data: { visibility_km: 24, humidity: 60, cloud_cover: 100, cloud_low: 0, cloud_mid: 0, cloud_high: 100 },
    twilight_minutes: 25, cloud_structure: { centerCloud: 100 }, sector_openings: { corridor: 100 },
    reasons: ['日落方向低云较少，地平线比较开阔', '日落核心方向无遮挡', '远方云幕连续', '天气型信号明确（阴天 强度 100%）',
      '反太阳方向存在高云背景', '大气能见度较好'],
    warnings: ['缺少足够的中高云作为云幕']
  });
}

test('Shanghai: full high cloud is not reported as missing; overcast is no longer a favourable item', () => {
  const SS = explainSS();
  const out = plain(SS.explain.build(shanghai()));
  assert.equal(out.warnings[0], '日落方向中高云过满，云层偏厚，阳光不易照亮云底');
  assert.ok(!out.warnings.includes('中高云接近满天，云层偏厚，晚霞不易铺开'), 'canvas and cloud-potential illumination merge into one item');
  assert.ok(out.warnings.includes('当前天气型为阴天，云层厚，整体不利于晚霞'));
  assert.ok(!out.warnings.some(w => w.includes('缺少')), out.warnings.join('|'));
  assert.ok(!out.reasons.some(r => r.includes('天气型信号明确')));
  assert.ok(!out.reasons.includes('远方云幕连续'), 'canvas reasons drop when the canvas is a listed loss');
  assert.ok(out.reasons.includes('日落方向低云较少，地平线比较开阔'));
  assert.ok(out.reasons.length <= 3);
  assert.equal(out.meta.losses[0].source, 'cloud');
});

test('cloud wording follows raw cover: mid cloud is not "missing", little cloud is', () => {
  const SS = explainSS();
  const midOnly = plain(SS.explain.build(fixture({ score: 50, base_score: 50, components: { sky_canvas: 50 },
    data: { cloud_high: 0, cloud_mid: 50, cloud_low: 5 } })));
  assert.ok(midOnly.warnings.includes('中高云量不在理想范围，云幕与光照条件一般'));
  assert.ok(!midOnly.warnings.some(w => w.includes('很少') || w.includes('缺少')));
  const little = plain(SS.explain.build(fixture({ score: 40, base_score: 40, components: { sky_canvas: 30 },
    data: { cloud_high: 10, cloud_mid: 5, cloud_low: 5 } })));
  assert.ok(little.warnings.includes('日落方向中高云很少，缺少可被映红的云幕'));
});

test('post-engine factors are explained with their point change', () => {
  const SS = explainSS();
  const down = plain(SS.explain.build(fixture({ score: 36, base_score: 60, nowcast_active: true, sky_evolution: { gwFactor: 0.6 } })));
  assert.equal(down.warnings[0], '临近日落的实况（降水 / 雷达 / 卫星）显示日落方向不易放晴，分数下调约 24 分');
  const inactive = plain(SS.explain.build(fixture({ score: 60, base_score: 60, nowcast_active: false, sky_evolution: { gwFactor: 0.6 } })));
  assert.ok(!inactive.warnings.some(w => w.includes('临近日落')), 'gwFactor only applies while the golden window is active');
  const up = plain(SS.explain.build(fixture({ score: 77, base_score: 70, sky_evolution_factor: 1.1 })));
  assert.equal(up.reasons[0], '全天空云况在好转，分数上调约 7 分');
  const tiny = plain(SS.explain.build(fixture({ score: 72, base_score: 70, sky_evolution_factor: 1.03 })));
  assert.ok(!tiny.reasons.some(r => r.includes('上调')), 'gains under 3 points are not listed');
  const sky = plain(SS.explain.build(fixture({ score: 52, base_score: 70, sky_evolution_factor: 0.75,
    all_day_sky_state: { label: '云层加厚中' } })));
  assert.equal(sky.warnings[0], '全天空状态为“云层加厚中”，分数下调约 18 分');
});

test('low scores always carry a warning and at most two favourable items', () => {
  const SS = explainSS();
  for (const result of [
    fixture({ score: 30, base_score: 30, components: { sky_canvas: 75, horizon: 75, illumination: 75, atmosphere: 75, weather: 75 }, penalty: 3 }),
    fixture({ score: 18, base_score: 18, components: { sky_canvas: 20, horizon: 30, illumination: 15, atmosphere: 40, weather: 25 }, horizon_gate: 0.5 }),
    fixture({ score: 15, base_score: 15, hard_gates: ['能见度极低（不足 2 km）'], warnings: ['硬限制：能见度极低（不足 2 km）'] })
  ]) {
    const out = plain(SS.explain.build(result));
    assert.ok(out.warnings.length >= 1, JSON.stringify(out));
    assert.ok(out.reasons.length <= 2);
    assert.ok(!out.reasons.includes('整体条件一般，可留意临近时段的变化'));
  }
  const good = plain(SS.explain.build(fixture({ score: 80, base_score: 80 })));
  assert.ok(good.reasons.length >= 1);
});

test('engine phrases: every literal in js/engine.js is classified; unknown text passes through', () => {
  const SS = explainSS();
  const source = readFileSync(join(ROOT, 'js/engine.js'), 'utf8');
  const literals = Array.from(source.matchAll(/(?:reasons|warnings)\.push\(\s*'([^']*)'/g), m => m[1]);
  assert.ok(literals.length >= 24, String(literals.length));
  for (const text of literals) assert.ok(SS.explain.classify(text), 'unclassified engine phrase: ' + text);
  const service = readFileSync(join(ROOT, 'js/prediction_service.js'), 'utf8');
  for (const m of service.matchAll(/result\.warnings\.push\(\s*'([^']*)'/g)) assert.ok(SS.explain.classify(m[1]), m[1]);
  const out = plain(SS.explain.build(fixture({ reasons: ['未来新增的有利说明'], warnings: ['未来新增的提示', '日落时段存在降水风险（概率 60%）'] })));
  assert.ok(out.reasons.includes('未来新增的有利说明'));
  assert.ok(out.warnings.includes('未来新增的提示'));
  assert.ok(out.warnings.includes('日落时段存在降水风险（概率 60%）'));
});

test('apply is idempotent, keeps engine text for debugging and changes only text fields', () => {
  const SS = explainSS();
  const original = shanghai();
  const before = plain(original);
  const once = plain(SS.explain.apply(original));
  const twice = plain(SS.explain.apply(original));
  assert.deepEqual(twice, once);
  const cachedCopy = plain(SS.explain.apply(Object.assign({}, JSON.parse(JSON.stringify(once)), { result_cache_status: 'HIT' })));
  assert.deepEqual(cachedCopy.reasons, once.reasons);
  assert.deepEqual(cachedCopy.warnings, once.warnings);
  assert.deepEqual(once.engine_reasons, before.reasons);
  assert.deepEqual(once.engine_warnings, before.warnings);
  const strip = r => { const c = { ...r }; for (const k of ['reasons', 'warnings', 'engine_reasons', 'engine_warnings', 'explain']) delete c[k]; return c; };
  assert.deepEqual(strip(once), strip(before));
});

test('atmosphere quality factor Q puts a hazy atmosphere into the top items', () => {
  const SS = explainSS();
  const result = fixture({ score: 55, base_score: 55, components: { sky_canvas: 80, horizon: 80, illumination: 80, atmosphere: 20, weather: 80 },
    data: { visibility_km: 3, aod: 0.25, pm25: 10, humidity: 55 } });
  const out = plain(SS.explain.build(result));
  const atm = out.meta.losses.find(l => l.source === 'atmosphere');
  assert.ok(atm.selected && atm.loss > 15, JSON.stringify(atm));
  assert.ok(BASE_WEIGHTS.atmosphere * 80 < 5, 'component weight alone would stay under the 5-point threshold');
  assert.ok(out.warnings.includes('能见度一般（约 3 km），远处色彩可能偏淡'));
});

test('horizon gate: a blocked horizon is the first item and mentions the discount', () => {
  const SS = explainSS();
  const out = plain(SS.explain.build(fixture({ score: 30, base_score: 30, components: { horizon: 35 }, horizon_gate: 0.5,
    sector_openings: { corridor: 30 } })));
  assert.equal(out.meta.losses[0].source, 'horizon');
  assert.equal(out.warnings[0], '日落方向低云较多，地平线被遮挡，整体效果打折');
  const clearDay = plain(SS.explain.build(fixture({ score: 40, base_score: 40, components: { horizon: 100, sky_canvas: 85 },
    clear_sky: { horizon_factor: 0.7, hint: true } })));
  assert.ok(clearDay.warnings.includes('天空几乎无云，地平线方向缺少可被映照的云'));
  const clearFew = plain(SS.explain.build(fixture({ score: 35, base_score: 35, components: { horizon: 100, sky_canvas: 26, illumination: 10 },
    clear_sky: { horizon_factor: 0.7, hint: true }, data: { cloud_high: 0, cloud_mid: 0, cloud_low: 0 }, cloud_structure: { centerCloud: 0 } })));
  assert.equal(clearFew.warnings[0], '天空几乎无云，缺少可被夕阳映红的云');
  assert.ok(!clearFew.warnings.includes('日落方向中高云很少，缺少可被映红的云幕'));
  assert.ok(!clearFew.warnings.includes('天空几乎无云，地平线方向缺少可被映照的云'));
});

test('illumination wording follows the dominant shortfall: twilight, data, or cloud amount merged with the canvas', () => {
  const SS = explainSS();
  const ill = (overrides) => plain(SS.explain.build(fixture({ score: 50, base_score: 50, ...overrides }))).warnings[0];
  // solar = 30 + 70 × 15/35 = 60, potential 80 → illumination 48
  assert.equal(ill({ twilight_minutes: 15, components: { illumination: 48 } }), '日落后天色暗得快（昏影约 15 分钟），云层被照亮的时间短');
  // solar = 90, potential 28 → 25.2; corridor high + mid 160
  assert.equal(ill({ twilight_minutes: 30, components: { illumination: 25 }, cloud_structure: { centerCloud: 160 } }), '日落方向中高云过满，云层偏厚，阳光不易照亮云底');
  // corridor sum 110 with local 32 / 28 is not "too full" (ideal 60 + 54 already exceeds 100)
  assert.equal(ill({ twilight_minutes: 30, components: { illumination: 25 }, cloud_structure: { centerCloud: 110 }, data: { cloud_high: 32, cloud_mid: 28 } }), '中高云量不在理想范围，云幕与光照条件一般');
  assert.equal(ill({ components: { illumination: 20 }, cloud_structure: { centerCloud: 10 }, data: { cloud_high: 5, cloud_mid: 5 } }), '日落方向中高云很少，缺少可被映红的云幕');
  // solar 100, data 0.75, potential 90 → 67.5
  assert.equal(ill({ components: { illumination: 67 }, illumination_data_factor: 0.75 }), '日落方向远处云量数据不全，光照条件按保守估计');
  const split = plain(SS.explain.build(fixture({ score: 40, base_score: 40, twilight_minutes: 10, components: { illumination: 45, sky_canvas: 30 },
    data: { cloud_high: 100, cloud_mid: 0 } })));
  assert.ok(split.warnings.includes('中高云接近满天，云层偏厚，晚霞不易铺开'), 'canvas keeps its own wording when illumination is twilight-limited');
  assert.ok(split.warnings.some(w => w.startsWith('日落后天色暗得快')));
});

test('loss decomposition sums exactly to 100 − P × Q × gate, including rounded weights and the clear-sky factor', () => {
  const SS = explainSS();
  const cases = [
    shanghai(),
    fixture({ components: { sky_canvas: 33, horizon: 61, illumination: 12, atmosphere: 47, weather: 70 }, horizon_gate: 0.9, clear_sky: { horizon_factor: 0.7 } }),
    fixture({ components: { sky_canvas: 5, horizon: 15, illumination: 0, atmosphere: 100, weather: 25 }, horizon_gate: 0.25,
      regime_state: { dynamicWeight: { skyCanvas: 0.13, horizon: 0.52, illumination: 0.29, atmosphere: 0.02, weather: 0.05 } } })
  ];
  for (const result of cases) {
    const b = plain(SS.explain.lossBreakdown(result));
    const sum = Object.values(b.gaps).reduce((a, v) => a + v, 0) + b.horizonClear + b.qLoss + b.gateLoss;
    assert.ok(Math.abs(sum - (100 - b.P * b.Q * b.gate)) < 1e-9, sum + ' vs ' + (100 - b.P * b.Q * b.gate));
    assert.ok(Math.abs(Object.values(b.weights).reduce((a, v) => a + v, 0) - 1) < 1e-12);
  }
});

test('real engine results: explanation keeps scores and never reports the old misleading phrases', () => {
  const SS = load(createRuntime(), [...CORE_FILES, 'js/explain.js']);
  const lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  for (const layers of [{ low: 0, mid: 0, high: 100, cloud: 100 }, { low: 70, mid: 0, high: 2, cloud: 72 },
    { low: 5, mid: 30, high: 40, cloud: 55 }, { low: 0, mid: 0, high: 0, cloud: 0 }]) {
    const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
    const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
    const result = SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
      localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
      sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
      spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0 });
    const score = result.score, components = plain(result.components);
    SS.explain.apply(result);
    assert.equal(result.score, score);
    assert.deepEqual(plain(result.components), components);
    const out = plain({ reasons: result.reasons, warnings: result.warnings });
    assert.ok(!out.warnings.includes('缺少足够的中高云作为云幕'));
    assert.ok(!out.reasons.some(r => r.startsWith('天气型信号明确（')));
    if (score < SS.explain.lowScoreLine()) assert.ok(out.warnings.length >= 1, JSON.stringify({ score, out }));
    if (layers.high === 100) assert.ok(!out.warnings.some(w => w.includes('很少') || w.includes('缺少可被')), out.warnings.join('|'));
  }
});

test('index.html loads explain.js before the prediction service with the shared asset revision', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="js/explain.js?v=2.5.5.37-app25537"></script>'));
  assert.ok(html.indexOf('src="js/explain.js') < html.indexOf('src="js/prediction_service.js'));
});
