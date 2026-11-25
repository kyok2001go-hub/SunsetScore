/* ============================================================
 * SunsetScore V2.5.5.37 - 预测解读文案（只改文案，不改分数）
 * 在最终分数（引擎分 × F_sky × F_gw）之后，按扣分来源重新生成“有利项 / 不利项”。
 * 损失按 理想 100 → P → P × Q → P × Q × gate 顺序拆分，再加天气扣分与引擎后修正；
 * 只读取结果对象与 SS.modelConfig，不访问网络、DOM 或缓存。js/engine.js 不改。
 * 依据：ref_docs/PRD/V2.5.5.37--预测解读文案修正方案.md
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var LOSS_MIN = 5;          /* 决策 3：损失 ≥ 5 分才列入 */
  var TOP_LOSS = 3;          /* 决策 3：取前 3 项 */
  var MAX_WARNINGS = 5;
  var FAVORABLE_MIN = 70;    /* 组件分 ≥ 70 才说有利；< 70 才计组件缺口 */
  var F_GAIN_MIN = 1.02;
  var GAIN_POINTS_MIN = 3;   /* 上调不足 3 分不单列，避免与下调项相互抵消的噪声 */
  var CENTER_FULL = 150;     /* 走廊高云 + 中云之和（0–200）：理想云量 60 + 54 也超过 100，过满取 150 */
  var FEW_TEXT = '日落方向中高云很少，缺少可被映红的云幕';
  var CLEAR_TEXT = '天空几乎无云，地平线方向缺少可被映照的云';
  var COMPONENTS = ['sky_canvas', 'horizon', 'illumination', 'atmosphere', 'weather'];
  var WEIGHT_KEYS = { sky_canvas: 'skyCanvas', horizon: 'horizon', illumination: 'illumination', atmosphere: 'atmosphere', weather: 'weather' };
  var BAD_REGIMES = {
    OVERCAST: '当前天气型为阴天，云层厚，整体不利于晚霞',
    HAZY: '当前天气型为雾霾，大气浑浊，整体不利于晚霞',
    FRONT_PASSING: '锋面正在过境，云雨变化大，晚霞条件不稳定',
    STORM_APPROACHING: '强天气系统正在逼近，整体不利于晚霞'
  };
  var GOOD_REGIMES = { PARTLY_CLOUDY: true, RAIN_TO_CLEAR: true };
  var POSITIVE = {
    sky_canvas: '中高云条件较好，有机会形成云幕',
    horizon: '日落方向低云较少，地平线比较开阔',
    illumination: '日落方向的中高云有机会被阳光照亮',
    atmosphere: '大气比较通透',
    weather: '日落前后天气条件比较平稳'
  };

  /* 引擎（js/engine.js）与 prediction_service 追加的原文分类。
   * keep：判断正确，按原文保留（component 用于有利项的组件门槛与互斥）；
   * replace：由本模块重新生成；drop：删除。不在清单中的原文按原样保留。 */
  var ENGINE_PHRASES = [
    { text: '日落方向低云较少，地平线比较开阔', action: 'replace' },
    { text: '日落方向低云较多，地平线不够开阔', action: 'replace' },
    { text: '日落核心方向无遮挡', action: 'keep', component: 'horizon' },
    { text: '太阳附近形成云幕结构', action: 'keep', component: 'sky_canvas' },
    { text: '云幕集中度好，中心云量显著高于两侧', action: 'keep', component: 'sky_canvas' },
    { text: '远方云幕连续', action: 'keep', component: 'sky_canvas' },
    { text: '云层正在向远方集中', action: 'keep', component: 'sky_canvas' },
    { text: '云层正在逼近，日落前景可能转差', action: 'keep' },
    { text: '晴空正在从日落方向推进', action: 'keep', component: 'weather' },
    { text: '天空打开速度快，雨后晚霞潜力增强', action: 'keep', component: 'weather' },
    { prefix: '天气型信号明确（', action: 'replace' },
    { prefix: '天气型正在向有利方向过渡（', action: 'keep', component: 'weather' },
    { text: '天气型正在转差，日落时段天空条件可能恶化', action: 'keep' },
    { text: '反太阳方向存在高云背景', action: 'keep', component: 'sky_canvas' },
    { text: '中高云条件适合形成云幕', action: 'replace' },
    { text: '缺少足够的中高云作为云幕', action: 'replace' },
    { text: '降雨在日落前黄金窗口内结束，日落方向低云正在减少', action: 'keep', component: 'weather' },
    { text: '大气能见度较好', action: 'keep', component: 'atmosphere' },
    { text: '气溶胶偏多，可能影响夕阳色彩', action: 'keep' },
    { text: '大气透明度一般（PM2.5 偏高）', action: 'keep' },
    { prefix: '日落时段存在降水风险（概率 ', action: 'keep' },
    { prefix: '硬限制：', action: 'keep' },
    { text: '全天空云场暂时无法获取，只用了部分数据，参考价值有限', action: 'keep' },
    { text: '整体条件一般，可留意临近时段的变化', action: 'drop' },
    { prefix: '实况', action: 'keep' }
  ];

  function num(value) { return typeof value === 'number' && isFinite(value) ? value : null; }
  function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }
  function gauss(v, center, width) { var d = (v - center) / width; return 100 * Math.exp(-0.5 * d * d); }
  function scoring() { return (SS.modelConfig && SS.modelConfig.scoring) || {}; }

  function classify(text) {
    for (var i = 0; i < ENGINE_PHRASES.length; i++) {
      var p = ENGINE_PHRASES[i];
      if (p.text != null ? p.text === text : String(text).indexOf(p.prefix) === 0) return p;
    }
    return null;
  }

  function levelLine(label, fallback) {
    var levels = scoring().levels || [];
    for (var i = 0; i < levels.length; i++) if (levels[i].label === label) return levels[i].min;
    return fallback;
  }
  function lowScoreLine() { return levelLine('一般', 49); }
  function goodScoreLine() { return levelLine('很好', 66); }

  /* 归一化动态权重：结果中权重四舍五入到两位小数，和不一定为 1。 */
  function weightsOf(result, comps) {
    var dyn = (result.regime_state && result.regime_state.dynamicWeight) || scoring().weights || {};
    var out = {}, sum = 0;
    COMPONENTS.forEach(function (k) {
      var w = num(dyn[WEIGHT_KEYS[k]]);
      if (w != null && w > 0 && comps[k] != null) { out[k] = w; sum += w; }
    });
    if (sum > 0) Object.keys(out).forEach(function (k) { out[k] /= sum; });
    return out;
  }

  function lossBreakdown(result) {
    var cfg = scoring(), raw = result.components || {}, comps = {};
    COMPONENTS.forEach(function (k) { comps[k] = num(raw[k]); });
    var w = weightsOf(result, comps);
    var clear = result.clear_sky && num(result.clear_sky.horizon_factor);
    var horizonFactor = clear != null ? clamp(clear, 0, 1) : 1;
    var P = 0, gaps = {};
    Object.keys(w).forEach(function (k) {
      var c = comps[k];
      P += w[k] * c * (k === 'horizon' ? horizonFactor : 1);
      gaps[k] = w[k] * (100 - c);
    });
    var horizonClear = w.horizon != null ? w.horizon * comps.horizon * (1 - horizonFactor) : 0;
    var aq = cfg.atmosphereQuality || { base: 0.70, scale: 0.30 };
    var atm = comps.atmosphere != null ? comps.atmosphere : 55;
    var Q = aq.base + aq.scale * atm / 100;
    var gate = num(result.horizon_gate); if (gate == null) gate = 1;
    var base = num(result.base_score); if (base == null) base = num(result.score) || 0;
    var fsky = num(result.sky_evolution_factor); if (fsky == null) fsky = 1;
    var fgw = result.nowcast_active && result.sky_evolution ? num(result.sky_evolution.gwFactor) : null;
    if (fgw == null) fgw = 1;
    return {
      comps: comps, weights: w, P: P, Q: Q, gate: gate, gaps: gaps, horizonClear: horizonClear,
      horizonFactor: horizonFactor, qLoss: P * (1 - Q), gateLoss: P * Q * (1 - gate),
      penalty: Math.max(0, num(result.penalty) || 0), base: base, fsky: fsky, fgw: fgw,
      skyLoss: base * (1 - fsky), gwLoss: base * fsky * (1 - fgw)
    };
  }

  /* ---------- 子原因文案 ---------- */
  function cloudData(result) {
    var d = result.data || {};
    return { high: num(d.cloud_high), mid: num(d.cloud_mid), low: num(d.cloud_low) };
  }
  function cloudTooFull(cl) { return (cl.high != null && cl.high >= 90) || (cl.mid != null && cl.mid >= 80); }

  function canvasText(result) {
    var cl = cloudData(result);
    var mh = Math.max(cl.high || 0, cl.mid || 0);
    if (cloudTooFull(cl)) return '中高云接近满天，云层偏厚，晚霞不易铺开';
    if (mh < 20) return '日落时中高云很少，缺少可被映红的云幕';
    return '中高云量不在理想范围，云幕条件一般';
  }

  function horizonText(result, b, parts) {
    if (parts.clear >= parts.gap && parts.clear >= parts.gate) return CLEAR_TEXT;
    var corridor = result.sector_openings ? num(result.sector_openings.corridor) : null;
    if (b.gate < 1 || (corridor != null && corridor < 40)) return '日落方向低云较多，地平线被遮挡，整体效果打折';
    return '日落方向低云偏多，地平线不够开阔';
  }

  function illuminationParts(result) {
    var model = scoring().illuminationModel || {};
    var saturation = num(model.twilightSaturationMinutes) || 35;
    var minutes = num(result.twilight_minutes);
    var solar = minutes == null ? 100 : 30 + 70 * clamp(minutes / saturation, 0, 1);
    var dataFactor = num(result.illumination_data_factor); if (dataFactor == null) dataFactor = 1;
    var c = num(result.components && result.components.illumination);
    var potential = c != null && solar * dataFactor > 0 ? clamp(c / (solar * dataFactor) * 100, 0, 100) : null;
    return { minutes: minutes, solar: solar, dataFactor: dataFactor, potential: potential };
  }

  /* 光照子原因：日落角度 / 数据系数 / 云幕潜力，取相对缺口最大的一项。 */
  function illuminationCause(result) {
    var p = illuminationParts(result);
    var shortSolar = 1 - p.solar / 100, shortData = 1 - p.dataFactor;
    var shortPotential = p.potential == null ? 0 : 1 - p.potential / 100;
    if (shortSolar > shortPotential && shortSolar >= shortData) {
      return { kind: 'solar', text: '日落后天色暗得快（昏影约 ' + Math.round(p.minutes) + ' 分钟），云层被照亮的时间短' };
    }
    if (shortData > shortPotential) return { kind: 'data', text: '日落方向远处云量数据不全，光照条件按保守估计' };
    return { kind: 'potential' };
  }

  /* 云幕潜力与云幕组件同源（中高云量），合并为一条“中高云”。 */
  function cloudAmountText(result) {
    var cl = cloudData(result), mh = Math.max(cl.high || 0, cl.mid || 0);
    var center = result.cloud_structure ? num(result.cloud_structure.centerCloud) : null;
    if (cloudTooFull(cl) || (center != null && center >= CENTER_FULL)) return '日落方向中高云过满，云层偏厚，阳光不易照亮云底';
    if (mh < 20 || (center != null && center < 40)) return FEW_TEXT;
    return '中高云量不在理想范围，云幕与光照条件一般';
  }

  function atmosphereText(result) {
    var cfg = scoring(), d = result.data || {};
    var aw = cfg.atmosphereWeights || { visibility: 0.35, aod: 0.30, pm25: 0.20, humidity: 0.15 };
    var options = [];
    var vis = num(d.visibility_km), aod = num(d.aod), pm = num(d.pm25), rh = num(d.humidity);
    if (vis != null) options.push({ gap: aw.visibility * (100 - 100 * (1 - Math.exp(-vis / (cfg.visibilityScaleKm || 8)))),
      text: '能见度一般（约 ' + (Math.round(vis * 10) / 10) + ' km），远处色彩可能偏淡' });
    if (aod != null) options.push({ gap: aw.aod * (100 - gauss(aod, cfg.aodCenter || 0.25, cfg.aodWidth || 0.18)),
      text: aod > (cfg.aodCenter || 0.25) ? '气溶胶偏多，可能影响夕阳色彩' : '大气过于洁净，散射偏弱，色彩可能偏淡' });
    if (pm != null) options.push({ gap: aw.pm25 * (100 - clamp(100 - (pm - 5) * (100 / 70), 0, 100)),
      text: '大气透明度一般（PM2.5 偏高）' });
    if (rh != null) options.push({ gap: aw.humidity * (100 - gauss(rh, cfg.humidityCenter || 55, cfg.humidityWidth || 30)),
      text: rh >= (cfg.humidityCenter || 55) ? '空气湿度偏大（约 ' + Math.round(rh) + '%），晚霞色彩可能偏灰' : '空气湿度偏低（约 ' + Math.round(rh) + '%）' });
    options.sort(function (a, b) { return b.gap - a.gap; });
    return options.length ? options[0].text : '大气通透度一般，色彩可能偏淡';
  }

  function weatherText(result) {
    return BAD_REGIMES[result.regime] || '日落前后天气条件一般，可能有降水或天气变化';
  }

  function skyStateLabel(result) {
    var state = result.all_day_sky_state;
    return state && state.label ? state.label : null;
  }

  /* ---------- 组装 ---------- */
  function lossItems(result, b) {
    var items = [], c = b.comps;
    function gap(k) { return c[k] != null && c[k] < FAVORABLE_MIN && b.gaps[k] != null ? b.gaps[k] : 0; }
    var cause = c.illumination != null ? illuminationCause(result) : null;
    if (cause && cause.kind === 'potential') {
      items.push({ source: 'cloud', components: ['sky_canvas', 'illumination'], loss: gap('sky_canvas') + gap('illumination'),
        parts: { sky_canvas: gap('sky_canvas'), illumination: gap('illumination') }, text: function () { return cloudAmountText(result); } });
    } else {
      if (c.sky_canvas != null) items.push({ source: 'sky_canvas', components: ['sky_canvas'], loss: gap('sky_canvas'), text: function () { return canvasText(result); } });
      if (cause) items.push({ source: 'illumination', components: ['illumination'], loss: gap('illumination'), text: function () { return cause.text; } });
    }
    var hParts = { gap: gap('horizon'), clear: b.horizonClear, gate: b.gateLoss };
    items.push({ source: 'horizon', components: ['horizon'], loss: hParts.gap + hParts.clear + hParts.gate, parts: hParts,
      text: function () { return horizonText(result, b, hParts); } });
    items.push({ source: 'atmosphere', components: ['atmosphere'], loss: gap('atmosphere') + b.qLoss, parts: { gap: gap('atmosphere'), q: b.qLoss },
      text: function () { return atmosphereText(result); } });
    if (c.weather != null) items.push({ source: 'weather', components: ['weather'], loss: gap('weather'), text: function () { return weatherText(result); } });
    items.push({ source: 'penalty', loss: b.penalty, text: function () { return '日落时段的降水或低能见度带来额外扣分'; } });
    items.push({ source: 'sky_evolution', loss: Math.max(0, b.skyLoss), text: function () {
      var label = skyStateLabel(result);
      return (label ? '全天空状态为“' + label + '”' : '全天空云况变化不利') + '，分数下调约 ' + Math.round(b.skyLoss) + ' 分';
    } });
    items.push({ source: 'golden_window', loss: Math.max(0, b.gwLoss), text: function () {
      return '临近日落的实况（降水 / 雷达 / 卫星）显示日落方向不易放晴，分数下调约 ' + Math.round(b.gwLoss) + ' 分';
    } });
    /* 晴空日：“中高云很少”与“地平线方向缺少可被映照的云”同源，合并为一条。 */
    var cloud = items.filter(function (it) { return it.source === 'cloud'; })[0];
    var horizon = items.filter(function (it) { return it.source === 'horizon'; })[0];
    if (cloud && horizon && horizon.loss > 0 && cloud.text() === FEW_TEXT && horizon.text() === CLEAR_TEXT) {
      cloud.loss += horizon.loss; cloud.components = cloud.components.concat(['horizon']);
      cloud.text = function () { return '天空几乎无云，缺少可被夕阳映红的云'; };
      items.splice(items.indexOf(horizon), 1);
    }
    items.sort(function (x, y) { return y.loss - x.loss; });
    return items;
  }

  function pushUnique(list, text) { if (text && list.indexOf(text) < 0) list.push(text); }

  function build(result) {
    var engineReasons = (result.engine_reasons || result.reasons || []).slice();
    var engineWarnings = (result.engine_warnings || result.warnings || []).slice();
    var score = num(result.score) || 0;
    var lowLine = lowScoreLine(), goodLine = goodScoreLine();
    var b = lossBreakdown(result), c = b.comps;
    var hardGated = Array.isArray(result.hard_gates) && result.hard_gates.length > 0;
    var items = lossItems(result, b);
    var selected = hardGated ? [] : items.filter(function (it) { return it.loss >= LOSS_MIN; }).slice(0, TOP_LOSS);
    if (!hardGated && score < lowLine && !selected.length && items.length && items[0].loss > 0) selected = [items[0]];

    var warnings = [], warnedComponents = {};
    selected.forEach(function (it) { pushUnique(warnings, it.text()); (it.components || []).forEach(function (k) { warnedComponents[k] = true; }); });
    var strength = result.regime_state ? num(result.regime_state.strength) : null;
    if (BAD_REGIMES[result.regime] && strength != null && strength >= 0.7) {
      pushUnique(warnings, BAD_REGIMES[result.regime]); warnedComponents.weather = true;
    }
    engineWarnings.forEach(function (text) {
      var p = classify(text);
      if (!p || p.action === 'keep') pushUnique(warnings, text);
    });
    if (score < lowLine && !warnings.length) warnings.push('多项条件都只是一般，没有单一的明显不利因素');
    warnings = warnings.slice(0, MAX_WARNINGS);

    /* 有利项：组件分 ≥ 70 才说有利；与不利项涉及的组件互斥。 */
    var candidates = [];
    function addReason(text, component, priority) {
      if (component && warnedComponents[component]) return;
      if (component && (c[component] == null || c[component] < FAVORABLE_MIN)) return;
      candidates.push({ text: text, priority: priority != null ? priority : (component ? c[component] : 50) });
    }
    addReason(POSITIVE.horizon, 'horizon');
    var cl = cloudData(result);
    if (!warnedComponents.sky_canvas && ((cl.high != null && cl.high >= 35 && cl.high <= 80) || (cl.mid != null && cl.mid >= 30 && cl.mid <= 75)) &&
        (cl.low == null || cl.low < 50) && !cloudTooFull(cl)) {
      candidates.push({ text: '中高云量适中，适合形成云幕', priority: c.sky_canvas != null ? c.sky_canvas : 60 });
    }
    if (GOOD_REGIMES[result.regime] && strength != null && strength >= 0.7) {
      candidates.push({ text: '天气型有利（' + String(result.regime_label || '').replace(/（强）$/, '') + '，信号强度 ' + Math.round(strength * 100) + '%）',
        priority: c.weather != null ? c.weather : 80 });
    }
    if (b.fsky >= F_GAIN_MIN && Math.round(b.base * (b.fsky - 1)) >= GAIN_POINTS_MIN) {
      candidates.push({ text: '全天空云况在好转，分数上调约 ' + Math.round(b.base * (b.fsky - 1)) + ' 分', priority: 101 });
    }
    if (b.fgw >= F_GAIN_MIN && Math.round(b.base * b.fsky * (b.fgw - 1)) >= GAIN_POINTS_MIN) {
      candidates.push({ text: '临近日落的实况显示天空在打开，分数上调约 ' + Math.round(b.base * b.fsky * (b.fgw - 1)) + ' 分', priority: 102 });
    }
    engineReasons.forEach(function (text) {
      var p = classify(text);
      if (!p) candidates.push({ text: text, priority: 50 });
      else if (p.action === 'keep') addReason(text, p.component);
    });
    candidates.sort(function (x, y) { return y.priority - x.priority; });
    var reasons = [];
    candidates.forEach(function (it) { pushUnique(reasons, it.text); });
    if (score >= goodLine && !reasons.length) {
      var best = COMPONENTS.filter(function (k) { return c[k] != null; }).sort(function (x, y) { return c[y] - c[x]; })[0];
      if (best) reasons.push(POSITIVE[best]);
    }
    var limit = score < lowLine ? 2 : score < goodLine ? 3 : 5;
    reasons = reasons.slice(0, limit);

    return {
      reasons: reasons,
      warnings: warnings,
      meta: {
        version: 1, P: round1(b.P), Q: round3(b.Q), gate: b.gate, horizon_factor: b.horizonFactor,
        base_score: b.base, sky_factor: b.fsky, gw_factor: b.fgw, hard_gated: hardGated, low_score: score < lowLine,
        losses: items.map(function (it) { return { source: it.source, loss: round1(it.loss), selected: selected.indexOf(it) >= 0 }; })
      }
    };
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* 覆盖结果中的文案；引擎原文保存在 engine_reasons / engine_warnings。幂等。 */
  function apply(result) {
    if (!result) return result;
    if (!result.engine_reasons) result.engine_reasons = (result.reasons || []).slice();
    if (!result.engine_warnings) result.engine_warnings = (result.warnings || []).slice();
    var out = build(result);
    result.reasons = out.reasons;
    result.warnings = out.warnings;
    result.explain = out.meta;
    return result;
  }

  SS.explain = {
    build: build, apply: apply, classify: classify, lossBreakdown: lossBreakdown,
    lowScoreLine: lowScoreLine, ENGINE_PHRASES: ENGINE_PHRASES
  };
})(typeof window !== 'undefined' ? window : globalThis);
