/* ============================================================
 * SunsetScore V2.3 - 页面渲染与通用交互
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var currentResult = null;
  var componentLabels = {
    sky_canvas: '云幕潜力', horizon: '地平线通透', illumination: '受光条件',
    atmosphere: '大气质量', weather: '天气稳定'
  };
  var weightKeys = {
    sky_canvas: 'skyCanvas', horizon: 'horizon', illumination: 'illumination',
    atmosphere: 'atmosphere', weather: 'weather'
  };
  var levelClasses = { '极佳': 'lv-best', '很好': 'lv-great', '不错': 'lv-good', '一般': 'lv-fair', '较差': 'lv-poor', '很差': 'lv-bad' };
  var evolutionLabels = { OPENING: '正在打开', OPEN: '开放', CLOSING: '正在闭合', BLOCKED: '持续遮挡', UNCERTAIN: '不确定' };
  var trendLabels = { OPENING: '↑ 云层正在打开', APPROACHING: '↓ 云层正在逼近', STABLE: '→ 天空状态稳定' };
  var riskLabels = { HIGH: '高', MEDIUM: '中', LOW: '低', NONE: '无' };
  var transitionLabels = { IMPROVING: '有利过渡', DETERIORATING: '转差', STABLE: '稳定' };
  var gradientLabels = { far_cloud_bank: '远方云幕', approaching_cloud: '云层逼近', neutral: '无明显趋势' };
  var clearingLabels = { far_to_near: '自远方推进', near_to_far: '自近处退去', uniform: '均匀打开', none: '无打开' };

  function $(id) { return root.document.getElementById(id); }
  function show(element) { if (element) element.classList.remove('hidden'); }
  function hide(element) { if (element) element.classList.add('hidden'); }
  function setText(id, value) { var element = $(id); if (element) element.textContent = value == null ? '—' : String(value); }
  function setLoading(message) {
    show($('status')); show($('loading')); hide($('error'));
    setText('loading-text', message || '正在分析…');
  }
  function showError(message) {
    show($('status')); hide($('loading')); show($('error'));
    setText('error', message || '预测失败，请稍后重试');
  }
  function clearStatus() { hide($('status')); hide($('loading')); hide($('error')); }
  function beginPrediction() {
    clearStatus(); hide($('result')); hide($('floating-feedback-wrapper'));
    var button = $('search-btn'); if (button) button.disabled = true;
  }
  function endPrediction() { var button = $('search-btn'); if (button) button.disabled = false; }
  function ringColor(score) {
    if (score >= 75) return '#ff7a45';
    if (score >= 60) return '#ffa940';
    if (score >= 40) return '#d3adf7';
    return '#6b7280';
  }
  function formatWind(wind) {
    if (!wind) return '—';
    var speed = wind.gustsKmH != null ? Math.round(wind.gustsKmH) : Math.round(wind.speedKmH || 0);
    var beaufort = SS.wind && SS.wind.formatBeaufort ? SS.wind.formatBeaufort(speed) : wind.beaufort;
    return (wind.label || '—') + ' · ' + speed + ' km/h' + (beaufort && beaufort.level ? '（' + beaufort.level + '级）' : '');
  }
  function renderSkyEvolution(result) {
    var state = result.all_day_sky_state;
    var motion = result.cloud_motion;
    var field = result.cloud_field;
    var evolution = result.sky_evolution;
    var block = $('sky-evolution-block');
    if (!state && !evolution) { hide(block); return; }
    show(block);
    var badge = $('sky-state-badge');
    if (badge) {
      badge.textContent = state ? (state.icon || '') + ' ' + (state.label || state.state) : (evolutionLabels[evolution.state] || evolution.state);
      badge.style.color = state && state.color || '#fff';
    }
    setText('sky-wind-val', formatWind(motion && motion.wind));
    var average = field && field.summary ? field.summary.avgCloudCover : null;
    setText('sky-trend-val', state ? state.description + (average != null ? '（全天云量 ' + average + '%）' : '') : '全天云量 ' + average + '%');
    var factor = result.sky_evolution_factor != null ? result.sky_evolution_factor : 1;
    setText('sky-factor-val', '×' + factor.toFixed(2) + (state && state.label ? ' · ' + state.label : ''));
    var open = evolution && evolution.sunsetOpenProbability;
    if (open == null && evolution && evolution.openProbability) open = evolution.openProbability['60m'];
    setText('sky-corridor-val', open != null ? '开放概率 ' + Math.round(open * 100) + '% · ' + (evolutionLabels[evolution.state] || '稳定') : '日落走廊通畅 · 背景支持良好');
    setText('sky-arrival-val', motion && motion.arrivalRisk ? motion.arrivalRisk.summaryText : '上游无密集浓云');
  }
  function appendNightWeatherIcon(host, cloudy) {
    // Local vector artwork, not a provider icon or a claim about the moon phase.
    var ns = 'http://www.w3.org/2000/svg';
    var svg = root.document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var moon = root.document.createElementNS(ns, 'path');
    moon.setAttribute('d', 'M19 3a11 11 0 1 0 10 16A10 10 0 0 1 19 3Z');
    moon.setAttribute('fill', '#ffd166');
    svg.appendChild(moon);
    if (cloudy) {
      var cloud = root.document.createElementNS(ns, 'path');
      cloud.setAttribute('d', 'M9 28a5 5 0 1 1 1-10 7 7 0 0 1 13-1 5.5 5.5 0 1 1 2 11Z');
      cloud.setAttribute('fill', '#e5e7f4');
      cloud.setAttribute('stroke', '#bfb3d8');
      cloud.setAttribute('stroke-width', '1');
      svg.appendChild(cloud);
    }
    host.appendChild(svg);
  }
  function renderNowcast(result) {
    var block = $('nowcast-block');
    var nowcast = result.nowcast;
    if (!result.nowcast_active || !nowcast) { hide(block); return; }
    show(block);
    var windowInfo = nowcast.goldenWindow;
    var timezone = result.timezone || 'UTC';
    var openText = windowInfo ? SS.time.formatHM(windowInfo.stopTimeMs, timezone) : (nowcast.trend === 'OPENING' ? '正在打开' : '暂无');
    if (result.sky_evolution && result.sky_evolution.sunsetOpenProbability != null) {
      openText += '（开放概率 ' + Math.round(result.sky_evolution.sunsetOpenProbability * 100) + '%）';
    }
    setText('n-open', openText);
    setText('n-duration', windowInfo ? windowInfo.durationMin + ' 分钟' : '—');
    setText('n-trend', (trendLabels[nowcast.trend] || '—') + (nowcast.appliedModifier ? '（修正 ' + (nowcast.appliedModifier > 0 ? '+' : '') + nowcast.appliedModifier + '）' : ''));
    setText('n-risk', riskLabels[nowcast.cloudRisk] || '—');
    setText('n-summary', nowcast.detail && nowcast.detail.precip && nowcast.detail.precip.summary ||
      '分钟降水暂不可用；天气时间线按可用小时预报展示');
    var timeline = $('n-timeline');
    if (!timeline) return;
    timeline.textContent = '';
    var items = nowcast.timeline || SS.nowcast.buildTimeline(nowcast.detail && nowcast.detail.precip, null, Date.now());
    items.forEach(function (weather) {
      var sunIcon = weather.icon === '☀️' || weather.icon === '⛅';
      var night = sunIcon && SS.solar && SS.solar.isDaytime &&
        SS.solar.isDaytime(weather.timeMs, result.latitude, result.longitude) === false;
      var item = root.document.createElement('div');
      item.className = 'timeline-item';
      item.title = (night ? '夜间，' : '') + weather.label + ' · ' + weather.source;
      var label = root.document.createElement('span'); label.className = 'timeline-time'; label.textContent = SS.time.formatHM(weather.timeMs, timezone);
      var icon = root.document.createElement('span'); icon.className = 'timeline-icon';
      if (night) {
        icon.className += ' timeline-icon--night';
        appendNightWeatherIcon(icon, weather.icon === '⛅');
      } else icon.textContent = weather.icon;
      icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', item.title);
      item.appendChild(label); item.appendChild(icon); timeline.appendChild(item);
    });
  }
  function renderBars(result) {
    var host = $('r-bars');
    if (!host) return;
    host.textContent = '';
    var weights = result.regime_state && result.regime_state.dynamicWeight;
    Object.keys(componentLabels).forEach(function (key) {
      var value = Number(result.components && result.components[key]) || 0;
      var row = root.document.createElement('div'); row.className = 'bar-row';
      var label = root.document.createElement('span'); label.className = 'bar-label';
      var name = root.document.createElement('span'); name.className = 'bar-label-name'; name.textContent = componentLabels[key]; label.appendChild(name);
      if (weights && weights[weightKeys[key]] != null) {
        var small = root.document.createElement('span'); small.className = 'bar-label-weight'; small.textContent = Math.round(weights[weightKeys[key]] * 100) + '% 权重'; label.appendChild(small);
      }
      var track = root.document.createElement('div'); track.className = 'bar-track';
      var fill = root.document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = Math.max(0, Math.min(100, value)) + '%'; track.appendChild(fill);
      var score = root.document.createElement('span'); score.className = 'bar-value'; score.textContent = value;
      row.appendChild(label); row.appendChild(track); row.appendChild(score); host.appendChild(row);
    });
  }
  function renderList(id, items, warning) {
    var host = $(id); if (!host) return;
    host.textContent = '';
    (items || []).forEach(function (text) { var item = root.document.createElement('li'); item.textContent = (warning ? '⚠ ' : '') + text; host.appendChild(item); });
    if (warning && !(items || []).length) hide(host); else show(host);
  }
  function addDetailGroup(host, title, rows) {
    var group = root.document.createElement('div'); group.className = 'detail-group';
    var heading = root.document.createElement('div'); heading.className = 'detail-group-title'; heading.textContent = title;
    var grid = root.document.createElement('div'); grid.className = 'detail-grid';
    rows.forEach(function (row) {
      var label = root.document.createElement('span'); label.textContent = row[0];
      var value = root.document.createElement('span'); value.textContent = row[1] == null ? '—' : String(row[1]);
      grid.appendChild(label); grid.appendChild(value);
    });
    group.appendChild(heading); group.appendChild(grid); host.appendChild(group);
  }
  function valueOrDash(value) { return value == null ? '—' : value; }
  function detailPhysicalScore(result) {
    var components = result.components || {};
    var weights = result.regime_state && result.regime_state.dynamicWeight;
    var score;
    if (weights) {
      score = weights.skyCanvas * components.sky_canvas + weights.horizon * components.horizon +
        weights.illumination * components.illumination + weights.atmosphere * components.atmosphere +
        weights.weather * components.weather;
    } else {
      score = 0.30 * components.sky_canvas + 0.20 * components.horizon + 0.20 * components.illumination +
        0.20 * components.atmosphere + 0.10 * components.weather;
    }
    return Number.isFinite(score) ? Math.round(score) + ' / 100' : '—';
  }
  function dynamicWeightText(regimeState) {
    if (!regimeState || !regimeState.dynamicWeight) return '—';
    var weights = regimeState.dynamicWeight;
    return '云 ' + Math.round(weights.skyCanvas * 100) + ' / 地平线 ' + Math.round(weights.horizon * 100) +
      ' / 受光 ' + Math.round(weights.illumination * 100) + ' / 大气 ' + Math.round(weights.atmosphere * 100) +
      ' / 天气 ' + Math.round(weights.weather * 100) + ' %';
  }
  function weatherScoreText(weatherScore) {
    if (!weatherScore) return '—';
    return '当前 ' + valueOrDash(weatherScore.current) + ' / 趋势 ' + valueOrDash(weatherScore.trend) +
      ' / 稳定 ' + valueOrDash(weatherScore.stability);
  }
  function evolutionDetailText(result) {
    var evolution = result.sky_evolution;
    if (!evolution) return '—（未启用或不在临近时段）';
    var parts = ['状态 ' + (evolutionLabels[evolution.state] || evolution.state || '—')];
    if (evolution.gwFactor != null) parts.push('概率因子 ×' + evolution.gwFactor);
    if (evolution.sunsetOpenProbability != null) parts.push('日落开放概率 ' + Math.round(evolution.sunsetOpenProbability * 100) + '%');
    if (evolution.sources && evolution.sources.length) parts.push('源 ' + evolution.sources.join('/'));
    return parts.join(' · ');
  }
  function nowcastDetailText(result) {
    var nowcast = result.nowcast;
    if (!nowcast) return '—（未启用或不在临近时段）';
    var parts = [];
    if (nowcast.appliedModifier != null) parts.push('修正 ' + (nowcast.appliedModifier > 0 ? '+' : '') + nowcast.appliedModifier);
    if (nowcast.sources && nowcast.sources.length) parts.push('源 ' + nowcast.sources.join('/'));
    var detail = nowcast.detail || {};
    if (detail.precip && detail.precip.source) parts.push('降水源 ' + detail.precip.source);
    if (detail.precip && detail.precip.stopMin != null) parts.push('雨停约 ' + detail.precip.stopMin + ' 分钟后');
    if (detail.radar && detail.radar.risk && detail.radar.risk !== 'NONE') parts.push('雷达风险 ' + (riskLabels[detail.radar.risk] || detail.radar.risk));
    return parts.join(' · ') || '—';
  }
  function tileSourceText(result, key) {
    var nowcast = result.nowcast;
    var status = nowcast && nowcast.sourcesStatus && nowcast.sourcesStatus[key];
    var detail = result.sky_evolution && result.sky_evolution.detail;
    if (status && status.status === 'DISABLED') return '已关闭';
    if (status && status.available) {
      return detail && detail[key] ? '🟢 可用，参与演化' : '🟢 可用，本次未参与演化';
    }
    if (detail && detail[key]) return '🟢 参与演化';
    if (status && status.status === 'TIMEOUT') return '⚪ 请求超时';
    if (status && status.status === 'FAILED') return '⚪ 请求或解析失败';
    return nowcast ? '⚪ 暂无有效数据' : '未请求';
  }
  function renderDetails(result) {
    var host = $('details'); if (!host) return;
    host.textContent = '';
    var d = result.data || {}, cs = result.cloud_structure || {}, field = result.cloud_field || {};
    var motion = result.cloud_motion || {}, state = result.all_day_sky_state || {}, evolution = result.sky_evolution || {};
    var regimeState = result.regime_state;
    var openings = result.sector_openings || {};
    var gradient = result.spatial_gradient || {};
    var clearing = result.clearing_front || {};
    var arrival = motion.arrivalRisk || {};
    var summary = field.summary || {};
    var note = root.document.createElement('p');
    note.className = 'detail-note';
    note.textContent = '公式：' + (regimeState
      ? 'Score = (Σ 组件×动态权重) × Q × GH + 结构加分 + 过渡加分 − Pweather'
      : 'Score = P × Q × GH + Bregime − Pweather') +
      (result.sky_evolution_factor != null ? ' · 全天演化 ×' + result.sky_evolution_factor : '') +
      (evolution.gwFactor != null ? ' · 黄金窗口 ×' + evolution.gwFactor : '') +
      '。所有参数为当前生产模型参数，后续基于真实观测校准。';
    host.appendChild(note);
    addDetailGroup(host, '📐 评分与模型拆解', [
      [regimeState ? '组件动态加权合成 P' : '基础物理评分 P', detailPhysicalScore(result)],
      ['大气质量修正 Q', (0.70 + 0.30 * ((result.components && result.components.atmosphere) || 0) / 100).toFixed(2)],
      ['地平线门控 GH', result.horizon_gate != null ? Number(result.horizon_gate).toFixed(2) : '—'],
      ['总加分（结构+过渡）', '+' + (result.bonus || 0)],
      ['天气风险扣分', '-' + (result.penalty || 0)],
      ['天气型强度', regimeState && regimeState.strength != null ? Math.round(regimeState.strength * 100) + '%' : '—'],
      ['动态权重分布', dynamicWeightText(regimeState)],
      ['Regime Transition', regimeState
        ? (transitionLabels[regimeState.transition] || '—') + ' · 评分 ' + valueOrDash(regimeState.transitionScore) +
          ' · 加分 ' + ((result.transition_bonus || 0) >= 0 ? '+' : '') + (result.transition_bonus || 0)
        : '—'],
      ['WeatherScore 组成', weatherScoreText(result.weather_score)]
    ]);
    addDetailGroup(host, '📊 极简基准对照与回测闭环', [
      ['当前动力学模型得分', result.score + ' 分 · ' + result.level],
      ['极简单峰基准得分', result.baseline_score != null ? result.baseline_score + ' 分 · ' + result.baseline_level : '—'],
      ['基线算法公式', result.baseline_detail && result.baseline_detail.formula || '—'],
      ['模型增益 / 偏差', result.baseline_score != null ? ((result.score - result.baseline_score >= 0 ? '+' : '') + (result.score - result.baseline_score) + ' 分') : '—']
    ]);
    addDetailGroup(host, '🌅 天空演化与风场动力学', [
      ['全天宏观状态', state.label ? (state.icon || '') + ' ' + state.label + '（演化因子 ×' + (result.sky_evolution_factor || 1) + '）' : '—'],
      ['全天空平均云量', summary.avgCloudCover != null ? summary.avgCloudCover + '%（低/中/高: ' + summary.avgCloudLow + '/' + summary.avgCloudMid + '/' + summary.avgCloudHigh + '%）' : '—'],
      ['空间云场不均度', summary.spatialVariance != null ? summary.spatialVariance + '（标准差）' : '—'],
      ['风向风速', formatWind(motion.wind)],
      ['分层云移动流速', motion.layerWinds
        ? '低云 ' + valueOrDash(motion.layerWinds.low && motion.layerWinds.low.speedKmH) + ' km/h · 中云 ' +
          valueOrDash(motion.layerWinds.mid && motion.layerWinds.mid.speedKmH) + ' km/h · 高云 ' +
          valueOrDash(motion.layerWinds.high && motion.layerWinds.high.speedKmH) + ' km/h'
        : '—'],
      ['上游浓云侵入预警', arrival.summaryText || '—'],
      ['30/60/120m 侵入概率', arrival.risk30m != null
        ? '30m: ' + Math.round(arrival.risk30m * 100) + '% / 60m: ' + Math.round(arrival.risk60m * 100) +
          '% / 120m: ' + Math.round(arrival.risk120m * 100) + '%'
        : '—'],
      ['日落走廊演化', evolutionDetailText(result)],
      ['实况瓦片信号源', '雷达: ' + tileSourceText(result, 'radar') + ' · 卫星: ' + tileSourceText(result, 'satellite')],
      ['Nowcasting 修正', nowcastDetailText(result)]
    ]);
    addDetailGroup(host, '☁️ 日落走廊云场结构', [
      ['云幕结构评分', valueOrDash(cs.bankScore)],
      ['中心云量 / 对比度', valueOrDash(cs.centerCloud) + ' / ' + valueOrDash(cs.contrast)],
      ['云幕连续性', valueOrDash(cs.continuity)],
      ['空间梯度（' + (gradientLabels[gradient.type] || '—') + '）', valueOrDash(gradient.value)],
      ['清空锋面（' + (clearingLabels[clearing.direction] || '—') + '）', clearing.rate != null
        ? '率 ' + clearing.rate + ' / 分 ' + clearing.score + ' / 信 ' + clearing.confidence : '—'],
      ['反日落评分（360°反向）', cs.antiSunsetScore != null
        ? cs.antiSunsetScore + (cs.antiSunsetCloud != null ? '（反向高云 ' + cs.antiSunsetCloud + '%）' : '') : '—'],
      ['分区开阔度（走廊/云幕）', valueOrDash(openings.corridor) + ' / ' + valueOrDash(openings.bank)]
    ]);
    addDetailGroup(host, '🌡️ 气象观测数据', [
      ['总云量 / 低 / 中 / 高', [d.cloud_cover, d.cloud_low, d.cloud_mid, d.cloud_high].map(valueOrDash).join(' / ') + ' %'],
      ['能见度', d.visibility_km != null ? d.visibility_km + ' km' : '—'],
      ['AOD / PM2.5', valueOrDash(d.aod) + ' / ' + valueOrDash(d.pm25)],
      ['相对湿度', d.humidity != null ? d.humidity + ' %' : '—'],
      ['民用昏影时长', d.twilight_minutes != null ? d.twilight_minutes + ' 分钟' : '—']
    ]);
    addDetailGroup(host, '📡 采样与数据可信度', [
      ['采样模式（V' + SS.version.app + '）', result.sampling_mode || '—'],
      ['全天空动力学网格', '8方位 × 4距离 × 3高度层（96 状态网格）'],
      ['空间采样点', (d.samples_fetched || 0) + ' / ' + (d.samples_expected || 0)],
      ['空间完整度 / 全天空方差', valueOrDash(result.spatial_completeness) + ' / ' + valueOrDash(result.spatial_variance) + '（360° 标准差）'],
      ['距离可靠性（经验诊断）', valueOrDash(result.distance_reliability == null ? null : result.distance_reliability.toFixed(3))],
      ['有效距离带覆盖', valueOrDash(result.distance_band_coverage == null ? null : Math.round(result.distance_band_coverage * 100) + '%')],
      ['数据新鲜度 / 缓存', (result.data_freshness || 0) + ' min / ' + (result.cache_status || '—')]
    ]);
  }
  function renderResult(result, options) {
    SS.domain.assertPredictionResult(result);
    currentResult = result;
    clearStatus(); show($('result')); show($('floating-feedback-wrapper'));
    setText('r-city', SS.citySearch.title({ name: result.city, admin1: result.admin1, country: result.country }));
    setText('r-local-time', '当地 ' + (result.local_time_str || '—') + ' (' +
      (result.timezone_str || SS.time.formatUtcOffset(result.utc_offset_seconds || 0)) + ')');
    var meta = (result.country ? result.country + ' · ' : '') + result.date + (result.sampling_mode ? ' · ' + result.sampling_mode + ' 采样' : '');
    if (result.cache_status === 'STALE') meta += ' · 过期缓存回退';
    if (options && options.fromCache) meta += ' · 缓存结果';
    setText('r-meta', meta);
    setText('r-score', result.score); setText('r-confidence', result.confidence + ' / 100');
    var badge = $('r-level'); if (badge) { badge.textContent = result.level; badge.className = 'level-badge ' + (levelClasses[result.level] || 'lv-fair'); }
    var ring = $('score-ring'); if (ring) { var color = ringColor(result.score); ring.style.background = 'conic-gradient(' + color + ' ' + result.score * 3.6 + 'deg, rgba(255,255,255,0.08) 0deg)'; ring.style.setProperty('--ring-color', color); }
    setText('r-golden-hour', result.golden_hour || '—');
    setText('r-sunset', (result.sunset_local || '—') + (result.hours_to_sunset < -0.5 ? '（今日已过）' : ''));
    setText('r-blue-hour', result.blue_hour || '—'); setText('r-azimuth', result.sunset_azimuth + '°');
    setText('r-viewing', result.best_viewing ? result.best_viewing.start + ' – ' + result.best_viewing.end + '（峰值 ' + result.best_viewing.peak + '）' : '—');
    setText('r-regime', result.regime_label + (result.regime_state && result.regime_state.strength != null ? ' · 强度 ' + Math.round(result.regime_state.strength * 100) + '%' : ''));
    renderSkyEvolution(result); renderNowcast(result); renderBars(result);
    renderList('r-reasons', result.reasons, false); renderList('r-warnings', result.warnings, true); renderDetails(result);
    if (SS.radarView) SS.radarView.render(result);
    if (SS.debugView) SS.debugView.render(result);
    var resultHost = $('result'); if (resultHost && resultHost.scrollIntoView) resultHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function toggleDetails() {
    var details = $('details'); if (!details) return;
    var open = details.classList.toggle('hidden') === false;
    setText('details-toggle', '为什么是这个分数？ ' + (open ? '▴' : '▾'));
  }
  SS.ui = {
    show: show, hide: hide, setLoading: setLoading, showError: showError,
    clearStatus: clearStatus, beginPrediction: beginPrediction, endPrediction: endPrediction,
    renderResult: renderResult, toggleDetails: toggleDetails,
    getCurrentResult: function () { return currentResult; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
