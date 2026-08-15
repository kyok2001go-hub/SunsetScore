/* ============================================================
 * SunsetScore V1.7 - UI 逻辑与主流程编排
 * 链路：geocode → 本地预报（取时区）→ 太阳计算 → 空间采样 → 评分 → 渲染
 * V1.7：展示天气型强度、Regime Transition 与动态权重占比
 * ============================================================ */
(function () {
  'use strict';
  var SS = window.SunsetScore;
  var cfg = SS.config;

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var form = $('search-form');
  var input = $('city-input');
  var btn = $('search-btn');
  var statusEl = $('status');
  var loadingEl = $('loading');
  var loadingText = $('loading-text');
  var errorEl = $('error');
  var resultEl = $('result');

  var COMPONENT_LABELS = {
    sky_canvas: '云幕',
    horizon: '地平线',
    illumination: '云层受光',
    atmosphere: '大气',
    weather: '天气过程'
  };
  var LEVEL_CLASS = { '极佳': 'lv-best', '很好': 'lv-great', '不错': 'lv-good', '一般': 'lv-fair', '较差': 'lv-poor', '很差': 'lv-bad' };
  /* V1.61 空间演化字段的中文映射 */
  var GRADIENT_TYPE_LABEL = { far_cloud_bank: '远方云幕', approaching_cloud: '云层逼近', neutral: '无明显趋势' };
  var CLEARING_DIR_LABEL = { far_to_near: '自远方推进', near_to_far: '自近处退去', uniform: '均匀打开', none: '无打开' };
  /* V1.7 天气型动态权重字段映射 */
  var TRANSITION_LABEL = { IMPROVING: '有利过渡', DETERIORATING: '转差', STABLE: '稳定' };
  var DYNAMIC_WEIGHT_KEY = {
    sky_canvas: 'skyCanvas', horizon: 'horizon', illumination: 'illumination',
    atmosphere: 'atmosphere', weather: 'weather'
  };

  /* ---------- 工具 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHM(shifted) { return pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()); }
  function fmtDate(shifted) {
    return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate());
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setLoading(text) {
    show(statusEl);
    show(loadingEl);
    hide(errorEl);
    if (text) loadingText.textContent = text;
  }
  function showError(msg) {
    show(statusEl);
    hide(loadingEl);
    show(errorEl);
    errorEl.textContent = msg;
    hide(resultEl);
  }
  function clearStatus() {
    hide(statusEl);
    hide(loadingEl);
    hide(errorEl);
  }

  /* 支持「纬度,经度」直接输入 */
  function parseCoordinates(text) {
    var m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: lat.toFixed(2) + ', ' + lon.toFixed(2), country: '', admin1: '', latitude: lat, longitude: lon };
  }

  /* ---------- 主流程 ---------- */
  function predict(query) {
    clearStatus();
    hide(resultEl);
    btn.disabled = true;

    var coords = parseCoordinates(query);
    var cacheKey = query.trim().toLowerCase().replace(/\s+/g, '_');

    Promise.resolve()
      .then(function () {
        setLoading('正在解析地理位置…');
        return coords || SS.data.geocode(query.trim());
      })
      .then(function (location) {
        /* 先取本地预报，拿到该地时区偏移 */
        setLoading('正在获取天气数据…');
        return SS.data.fetchForecast(location.latitude, location.longitude)
          .then(function (localForecast) {
            var offset = localForecast.utc_offset_seconds || 0;
            var nowUtc = new Date();
            var localNow = SS.data.toLocalShifted(nowUtc, offset);

            /* 缓存 key 加上当地日期：跨日自动失效 */
            var fullKey = cacheKey + '_' + fmtDate(localNow);
            var cached = SS.cache.get(fullKey);
            if (cached) {
              renderResult(cached, offset, true);
              return null;
            }

            /* 当地正午对应的 UTC 时刻，作为太阳计算的基准日 */
            var noonUtcMs = Date.UTC(
              localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 12
            ) - offset * 1000;

            var solar = SS.solar.getSunEvents(new Date(noonUtcMs), location.latitude, location.longitude);
            if (!solar) {
              throw new Error('该地区当前处于极昼或极夜，今天没有日落');
            }

            setLoading('正在采样日落方向的空间云场（13 个观测点）…');
            return SS.data.gather(location.latitude, location.longitude, solar.sunsetAzimuthDeg, localForecast)
              .then(function (gathered) {
                setLoading('正在计算晚霞指数…');
                var result = SS.engine.compute({
                  location: location,
                  utcOffsetSeconds: offset,
                  localNowUtc: nowUtc,
                  solar: solar,
                  sunsetLocal: SS.data.toLocalShifted(solar.sunset, offset),
                  samples: gathered.samples,
                  air: gathered.air,
                  expectedSampleCount: gathered.expectedSampleCount
                });

                var viewing = SS.engine.bestViewing(solar, cfg);
                result.best_viewing = {
                  start: fmtHM(SS.data.toLocalShifted(viewing.startUtc, offset)),
                  peak: fmtHM(SS.data.toLocalShifted(viewing.peakUtc, offset)),
                  end: fmtHM(SS.data.toLocalShifted(viewing.endUtc, offset))
                };
                result.sunset_local = fmtHM(SS.data.toLocalShifted(solar.sunset, offset));
                result.date = fmtDate(localNow);

                SS.cache.set(fullKey, result);
                renderResult(result, offset, false);
                return null;
              });
          });
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.error) console.error('[SunsetScore]', err);
        showError(err && err.message ? err.message : '预测失败，请检查网络后重试');
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  /* ---------- 渲染 ---------- */
  function ringColor(score) {
    if (score >= 75) return '#ff7a45';
    if (score >= 60) return '#ffa940';
    if (score >= 40) return '#d3adf7';
    return '#6b7280';
  }

  function renderResult(r, offset, fromCache) {
    clearStatus();
    show(resultEl);

    $('r-city').textContent = r.city + (r.admin1 && r.admin1 !== r.city ? ' · ' + r.admin1 : '');
    $('r-meta').textContent =
      (r.country ? r.country + ' · ' : '') + r.date + (fromCache ? ' · 缓存结果' : '');

    $('r-score').textContent = r.score;
    var badge = $('r-level');
    badge.textContent = r.level;
    badge.className = 'level-badge ' + (LEVEL_CLASS[r.level] || 'lv-fair');

    var ring = $('score-ring');
    var color = ringColor(r.score);
    ring.style.background = 'conic-gradient(' + color + ' ' + (r.score * 3.6) + 'deg, rgba(255,255,255,0.08) 0deg)';
    ring.style.setProperty('--ring-color', color);

    $('r-confidence').textContent = r.confidence + ' / 100';
    $('r-sunset').textContent = r.sunset_local;
    $('r-azimuth').textContent = r.sunset_azimuth + '°';
    $('r-viewing').textContent = r.best_viewing.start + ' – ' + r.best_viewing.end +
      '（峰值 ' + r.best_viewing.peak + '）';
    var regimeText = r.regime_label;
    if (r.regime_state && r.regime_state.strength != null) {
      regimeText += ' · 强度 ' + Math.round(r.regime_state.strength * 100) + '%';
    }
    $('r-regime').textContent = regimeText;

    /* 评分构成条形图（V1.7：标签下方小字显示动态权重占比） */
    var bars = $('r-bars');
    bars.innerHTML = '';
    var dynW = r.regime_state && r.regime_state.dynamicWeight;
    Object.keys(COMPONENT_LABELS).forEach(function (key) {
      var val = r.components[key];
      var weightText = null;
      if (dynW && dynW[DYNAMIC_WEIGHT_KEY[key]] != null) {
        weightText = Math.round(dynW[DYNAMIC_WEIGHT_KEY[key]] * 100) + '% 权重';
      }
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML =
        '<span class="bar-label"><span class="bar-label-name">' + COMPONENT_LABELS[key] + '</span>' +
        (weightText ? '<span class="bar-label-weight">' + weightText + '</span>' : '') +
        '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + val + '%"></div></div>' +
        '<span class="bar-value">' + val + '</span>';
      bars.appendChild(row);
    });

    /* 原因 / 提示 */
    var reasonsEl = $('r-reasons');
    reasonsEl.innerHTML = '';
    r.reasons.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = '✓ ' + t;
      reasonsEl.appendChild(li);
    });
    var warnEl = $('r-warnings');
    warnEl.innerHTML = '';
    r.warnings.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = '⚠ ' + t;
      warnEl.appendChild(li);
    });
    if (!r.warnings.length) hide(warnEl);

    /* 详情 */
    var d = r.data;
    var cs = r.cloud_structure || {};
    var so = r.sector_openings || {};
    var sg = r.spatial_gradient || {};
    var cf = r.clearing_front || {};
    var rs = r.regime_state;   /* V1.7 天气型状态（回退路径为 null） */
    $('details').innerHTML =
      '<div class="detail-grid">' +
      '<span>' + (rs ? '组件动态加权合成 P' : '基础物理评分 P') + '</span><span>' + detailP(r) + '</span>' +
      '<span>大气质量修正 Q</span><span>' + (0.70 + 0.30 * r.components.atmosphere / 100).toFixed(2) + '</span>' +
      '<span>地平线门控 G<sub>H</sub></span><span>' + r.horizon_gate.toFixed(2) + '</span>' +
      '<span>总加分（结构+过渡）</span><span>+' + r.bonus + '</span>' +
      '<span>天气型强度</span><span>' + (rs ? Math.round(rs.strength * 100) + '%' : '—') + '</span>' +
      '<span>Regime Transition</span><span>' + (rs
        ? (TRANSITION_LABEL[rs.transition] || '—') + ' · 评分 ' + rs.transitionScore +
          ' · 加分 ' + (r.transition_bonus >= 0 ? '+' : '') + r.transition_bonus
        : '—') + '</span>' +
      '<span>动态权重分布</span><span>' + fmtDynamicWeights(rs) + '</span>' +
      '<span>WeatherScore 组成</span><span>' + fmtWeatherScore(r.weather_score) + '</span>' +
      '<span>天气风险扣分</span><span>-' + r.penalty + '</span>' +
      '<span>云幕结构评分</span><span>' + (cs.bankScore != null ? cs.bankScore : '—') + '</span>' +
      '<span>中心云量 / 对比度</span><span>' + fmt4(cs.centerCloud, cs.contrast) + '</span>' +
      '<span>云幕连续性</span><span>' + (cs.continuity != null ? cs.continuity : '—') + '</span>' +
      '<span>空间梯度（' + (GRADIENT_TYPE_LABEL[sg.type] || '—') + '）</span><span>' + (sg.value != null ? sg.value : '—') + '</span>' +
      '<span>清空锋面（' + (CLEARING_DIR_LABEL[cf.direction] || '—') + '）</span><span>' +
        (cf.rate != null ? '率 ' + cf.rate + ' / 分 ' + cf.score + ' / 信 ' + cf.confidence : '—') + '</span>' +
      '<span>反日落评分</span><span>' + (cs.antiSunsetScore != null ? cs.antiSunsetScore : '—') + '</span>' +
      '<span>分区开阔度（走廊/云幕）</span><span>' + fmt4(so.corridor, so.bank) + '</span>' +
      '<span>距离预报可信度</span><span>' + (r.distance_confidence != null ? r.distance_confidence : '—') + '</span>' +
      '<span>总云量 / 低 / 中 / 高</span><span>' + fmt4(d.cloud_cover, d.cloud_low, d.cloud_mid, d.cloud_high) + ' %</span>' +
      '<span>能见度</span><span>' + (d.visibility_km != null ? d.visibility_km + ' km' : '—') + '</span>' +
      '<span>AOD / PM2.5</span><span>' + (d.aod != null ? d.aod : '—') + ' / ' + (d.pm25 != null ? d.pm25 : '—') + '</span>' +
      '<span>相对湿度</span><span>' + (d.humidity != null ? d.humidity + ' %' : '—') + '</span>' +
      '<span>民用昏影时长</span><span>' + d.twilight_minutes + ' 分钟</span>' +
      '<span>空间采样点</span><span>' + d.samples_fetched + ' / ' + d.samples_expected + '</span>' +
      '</div>' +
      '<p class="detail-note">公式：' + (rs
        ? 'Score = (Σ 组件×动态权重) × Q × G<sub>H</sub> + 结构加分 + 过渡加分 − P<sub>weather</sub>'
        : 'Score = P × Q × G<sub>H</sub> + B<sub>regime</sub> − P<sub>weather</sub>') +
      '，所有参数为初始经验值，未来将基于真实观测校准。</p>';

    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function detailP(r) {
    var c = r.components;
    var dw = r.regime_state && r.regime_state.dynamicWeight;
    var p;
    if (dw) {
      /* V1.7 动态权重加权合成 */
      p = dw.skyCanvas * c.sky_canvas + dw.horizon * c.horizon +
        dw.illumination * c.illumination + dw.atmosphere * c.atmosphere +
        dw.weather * c.weather;
    } else {
      /* V1.61 固定权重 */
      p = 0.30 * c.sky_canvas + 0.20 * c.horizon + 0.20 * c.illumination +
        0.20 * c.atmosphere + 0.10 * c.weather;
    }
    return Math.round(p) + ' / 100';
  }
  function fmtDynamicWeights(rs) {
    if (!rs || !rs.dynamicWeight) return '—';
    var w = rs.dynamicWeight;
    return '云 ' + Math.round(w.skyCanvas * 100) + ' / 地平线 ' + Math.round(w.horizon * 100) +
      ' / 受光 ' + Math.round(w.illumination * 100) + ' / 大气 ' + Math.round(w.atmosphere * 100) +
      ' / 天气 ' + Math.round(w.weather * 100) + ' %';
  }
  function fmtWeatherScore(ws) {
    if (!ws) return '—';
    return '当前 ' + ws.current + ' / 趋势 ' + ws.trend + ' / 稳定 ' + ws.stability;
  }
  function fmt4() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i] != null ? arguments[i] : '—');
    return parts.join(' / ');
  }

  /* ---------- 事件绑定 ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    predict(q);
  });

  $('quick-chips').addEventListener('click', function (e) {
    var target = e.target;
    if (target.tagName === 'BUTTON' && target.dataset.city) {
      input.value = target.dataset.city;
      predict(target.dataset.city);
    }
  });

  $('details-toggle').addEventListener('click', function () {
    var d = $('details');
    var open = d.classList.toggle('hidden') === false;
    $('details-toggle').textContent = '为什么是这个分数？ ' + (open ? '▴' : '▾');
  });
})();
