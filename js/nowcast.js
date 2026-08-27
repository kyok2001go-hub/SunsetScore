/* ============================================================
 * SunsetScore V2.0 - Nowcasting 数据适配层（V1.9 延续）
 * 三个数据源（任一失败静默降级，权重自动重归一）：
 *   1. precip    QWeather/Open-Meteo 分钟级降水 → 雨停时间 / RainClearScore
 *   2. radar     RainViewer 雷达瓦片三帧 → 走廊回波覆盖率序列 / 运动 / 到达风险
 *   3. satellite NASA GIBS 静止卫星三帧 → 走廊云覆盖率序列 / 距离分层
 * V2.0：几何/瓦片/走廊工具已抽到 corridor.js；覆盖率序列供 evolution.js
 *       做概率演化（指数衰减 + 不确定度）；score 只用于趋势诊断，不叠加到最终评分。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var rad = Math.PI / 180;

  function valid(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function gauss(v, center, width) {
    var d = (v - center) / width;
    return 100 * Math.exp(-0.5 * d * d);
  }
  function avg(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function fetchJson(url, options) {
    return SS.network.json(url, Object.assign({ timeoutMs: SS.modelConfig.network.observationTimeoutMs }, options));
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHM(utcMs, offsetSeconds) {
    var d = new Date(utcMs + offsetSeconds * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  /* ---------- Source 1：分钟级降水（Phase 1） ----------
     首选 QWeather /v7/minutely/5m（5 分钟粒度、中国区、需 API Key），
     未配置/失败时回退 Open-Meteo minutely_15（15 分钟粒度、全球无 Key）。
     两者统一归一化为 series {times, precip, stepMs, source} */

  function fetchQWeatherMinutePrecip(lat, lon, options) {
    var qw = SS.modelConfig.nowcast.qweather;
    if (!SS.modelConfig.nowcast.enabled || !qw || !qw.enabled || !qw.endpoint || typeof location === 'undefined' || location.protocol === 'file:') return Promise.resolve(null);
    var url = qw.endpoint + '?lat=' + encodeURIComponent(lat.toFixed(4)) + '&lon=' + encodeURIComponent(lon.toFixed(4));
    return fetchJson(url, options).then(function (json) {
      /* 注意：QWeather 业务错误也返回 HTTP 200，需检查业务状态码 */
      if (!json || json.code !== '200' || !json.minutely || json.minutely.length < 8) return null;
      var times = [], precip = [];
      json.minutely.forEach(function (m) {
        var p = parseFloat(m.precip);
        times.push(m.fxTime);
        precip.push(isFinite(p) && p >= 0 ? p : null);
      });
      var stepMs = times.length > 1 ? Date.parse(times[1]) - Date.parse(times[0]) : 300000;
      return {
        times: times, precip: precip, stepMs: stepMs,
        source: 'qweather', summary: json.summary || null
      };
    });
  }

  function fetchOpenMeteoMinutePrecip(lat, lon, options) {
    var url = SS.modelConfig.api.forecast +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&minutely_15=precipitation&forecast_minutely_15=120&timezone=auto';
    return fetchJson(url, options).then(function (json) {
      var m15 = json && json.minutely_15;
      if (!m15 || !m15.time || !m15.precipitation || m15.time.length < 8) return null;
      var times = m15.time.map(function (tStr) {
        return new Date(SS.time.fromOpenMeteoLocal(tStr, json.utc_offset_seconds || 0)).toISOString();
      });
      var stepMs = times.length > 1 ? Date.parse(times[1]) - Date.parse(times[0]) : 900000;
      return {
        times: times, precip: m15.precipitation, stepMs: stepMs,
        source: 'openmeteo', summary: null
      };
    });
  }

  /* 统一入口：QWeather → Open-Meteo 逐级回退 */
  async function fetchMinutePrecip(lat, lon, options) {
    options = options || {};
    SS.network.throwIfAborted(options.signal);
    if (!SS.modelConfig.nowcast.enabled) return null;
    try {
      var series = await fetchQWeatherMinutePrecip(lat, lon, options);
      if (series) return series;
    } catch (error) {
      SS.network.throwIfAborted(options.signal);
    }
    // Disabling QWeather keeps the independent Open-Meteo minute fallback available.
    return fetchOpenMeteoMinutePrecip(lat, lon, options);
  }

  // Read the interval containing the requested time. Never extend a stale series
  // by selecting a nearby value outside its actual coverage (5m or 15m).
  function precipAtSeries(series, timeMs) {
    if (!series || !series.times || !series.precip) return null;
    var step = series.stepMs;
    if (!valid(step) || step <= 0) {
      step = series.times.length > 1 ? Date.parse(series.times[1]) - Date.parse(series.times[0]) : 0;
    }
    if (!valid(step) || step <= 0) return null;
    for (var i = 0; i < series.times.length; i++) {
      var start = Date.parse(series.times[i]);
      if (timeMs >= start && timeMs < start + step) {
        var value = series.precip[i];
        return valid(value) && value >= 0 ? value : null;
      }
    }
    return null;
  }

  function buildTimeline(precip, forecast, nowMs) {
    var items = [];
    var h = forecast && forecast.hourly;
    var times = h && h.time ? h.time.map(function (t) {
      return SS.time.fromOpenMeteoLocal(t, forecast.utc_offset_seconds || 0);
    }) : [];
    for (var i = 0; i < 5; i++) {
      var time = nowMs + i * 30 * 60000;
      var rain = precipAtSeries(precip && precip.series, time);
      var source = rain != null ? '分钟降水' : '小时预报';
      var hourly = times.length && time >= times[0] && time <= times[times.length - 1]
        ? SS.cloudField.extractInterpolatedAt(forecast, time) : null;
      if (rain == null && hourly && h.precipitation) rain = hourly.precipitation;
      var cloud = hourly && h.cloud_cover ? hourly.cloud_cover : null;
      var icon, label;
      if (!valid(rain)) { icon = '❔'; label = '暂无此时段降水数据'; source = '无数据'; }
      else if (rain > 0) { icon = '🌧️'; label = '降水'; }
      else if (!valid(cloud)) { icon = '🌂'; label = '无降水（云况未知）'; }
      else if (cloud >= 80) { icon = '☁️'; label = '阴天，无降水'; }
      else if (cloud >= 30) { icon = '⛅'; label = '多云，无降水'; }
      else { icon = '☀️'; label = '晴朗，无降水'; }
      items.push({ timeMs: time, icon: icon, label: label, source: source });
    }
    return items;
  }

  /* 雨停分析（方案 4.4 节）：stopTime / nextRainTime / RainClearScore。
     时间基准逻辑，兼容 5 分钟（QWeather）与 15 分钟（Open-Meteo）两种粒度 */
  function analyzePrecip(series, nowMs) {
    if (!series || !series.times || !series.precip || series.times.length < 8) return null;
    var times = series.times, p = series.precip;
    var stepMs = series.stepMs || 300000;
    if (!valid(stepMs) || stepMs <= 0) return null;
    var rc = SS.modelConfig.nowcast.rainClear;

    /* 优先取包含当前时刻的区间；允许来源从下一个时次开始，但拒绝过期数据。 */
    var start = 0;
    while (start < times.length && Date.parse(times[start]) + stepMs <= nowMs) start++;
    if (start >= times.length || !valid(Date.parse(times[start])) ||
        Date.parse(times[start]) > nowMs + stepMs || !valid(p[start]) || p[start] < 0) return null;

    // Open-Meteo returns 120 *steps*, not 120 minutes. Analyse only the next two
    // hours of contiguous known data, never infer a rain stop across a data gap.
    var end = start;
    while (end < times.length && Date.parse(times[end]) < nowMs + 120 * 60000 &&
        valid(p[end]) && p[end] >= 0 &&
        (end === start || Date.parse(times[end]) === Date.parse(times[end - 1]) + stepMs)) end++;
    var coverageEndMs = Math.min(nowMs + 120 * 60000, Date.parse(times[end - 1]) + stepMs);

    function isDry(v) { return valid(v) && v >= 0 && v < rc.dryThresholdMm; }

    /* stopTime：首个"连续 ≥dryStreakMinutes 无雨"的起点（按粒度折算所需步数） */
    var reqSteps = Math.max(2, Math.ceil(rc.dryStreakMinutes * 60000 / stepMs));
    var stopMs = null, i, j;
    for (i = start; i <= end - reqSteps; i++) {
      if (Date.parse(times[i + reqSteps - 1]) + stepMs > coverageEndMs) break;
      var allDry = true;
      for (j = 0; j < reqSteps; j++) {
        if (!isDry(p[i + j])) { allDry = false; break; }
      }
      if (allDry) { stopMs = Math.max(nowMs, Date.parse(times[i])); break; }
    }

    var rainingNow = !isDry(p[start]);
    var stopMin = stopMs != null ? (stopMs - nowMs) / 60000 : null;

    /* nextRainTime：雨停之后再次下雨的时次；若现在无雨，则未来第一次下雨 */
    var nextRainMs = null;
    var scanFrom = stopMs != null ? i + reqSteps : start;
    for (j = scanFrom; j < end; j++) {
      if (!isDry(p[j])) { nextRainMs = Date.parse(times[j]); break; }
    }

    /* 强度趋势：当前 30 分钟均值 vs 其后 30 分钟均值 */
    var winSteps = Math.max(1, Math.round(30 * 60000 / stepMs));
    var head = avg(p.slice(start, Math.min(end, start + winSteps)).filter(valid));
    var tail = avg(p.slice(start + winSteps, Math.min(end, start + 2 * winSteps)).filter(valid));
    var intensifying = valid(head) && valid(tail) && tail - head >= 0.2;

    var score;
    if (rainingNow && intensifying) score = rc.intensifying;
    else if (rainingNow && stopMin == null) score = rc.persisting;
    else if (stopMin != null && stopMin <= 30) score = rc.stopWithin30;
    else if (stopMin != null && stopMin <= 60) score = rc.stopWithin60;
    else if (rainingNow) score = rc.persisting;
    else score = 0; /* 当前无雨且未来两小时无雨：中性 */

    /* 融合用趋势值（−1~+1）：停雨越快越正 */
    var trend = 0;
    if (stopMin != null) trend = clamp(1 - stopMin / 90, -1, 1);
    else if (rainingNow) trend = intensifying ? -1 : -0.5;

    var coverageMinutes = Math.max(0, Math.floor((coverageEndMs - Math.max(nowMs, Date.parse(times[start]))) / 60000));
    var summary = series.summary;
    if (!summary) {
      if (rainingNow && stopMin != null) summary = '预计约 ' + Math.ceil(stopMin) + ' 分钟后持续停雨';
      else if (rainingNow) summary = '未来约 ' + coverageMinutes + ' 分钟内未识别持续停雨时段';
      else if (nextRainMs != null) summary = '当前无明显降水，预计约 ' + Math.max(0, Math.ceil((nextRainMs - nowMs) / 60000)) + ' 分钟后有降水';
      else summary = '未来约 ' + coverageMinutes + ' 分钟无明显降水';
      summary += series.source === 'openmeteo' ? '（Open-Meteo 15分钟预报）' : '（分钟预报）';
    }
    return {
      available: true,
      source: series.source || 'unknown',
      summary: summary,
      coverageEndMs: coverageEndMs,
      rainingNow: rainingNow,
      stopTimeMs: stopMs,
      stopMin: stopMin != null ? Math.round(stopMin) : null,
      nextRainMs: nextRainMs,
      intensifying: intensifying,
      rainClearScore: score,
      trend: trend,
      series: { times: times, precip: p, start: start, stepMs: stepMs }
    };
  }

  /* ---------- Source 2：雷达雨系运动（RainViewer Weather Maps API，Phase 2） ----------
     免费公开端点（无需注册/密钥，仅个人与教育用途）：
     三帧雷达瓦片 → 日落走廊回波覆盖率序列（V2.0 演化输入）、质心运动向量 →
     ClearingVelocity 与 RainArrivalRisk（趋势诊断字段保留）。v2 API 最大 zoom=7 */

  /* 瓦片像素 → 回波：RainViewer 色斑图，RGB 任一通道非黑即视为回波 */
  function echoAt(data, off, thr) {
    return data[off + 3] >= thr &&
      (data[off] >= thr || data[off + 1] >= thr || data[off + 2] >= thr);
  }

  function fetchRadarFrames(options) {
    return fetchJson(SS.modelConfig.nowcast.radar.endpoint, options).then(function (json) {
      var host = (json && json.host) || 'https://tilecache.rainviewer.com';
      var past = (json && json.radar && json.radar.past) || [];
      var frames = past.filter(function (f) { return f && f.path && f.time; });
      if (frames.length < 2) throw new Error('雷达帧不足');
      /* V2.0：最近三帧 T-20/T-10/T（不足三帧时取可用最近帧），帧间隔约 10 分钟 */
      var n = Math.min(3, frames.length);
      return { host: host, frames: frames.slice(frames.length - n) };
    });
  }

  /* 回波是否出现在某地理点附近（瓦片像素近似） */
  function hasEchoNear(imgData, plan, lat, lon, rc, radiusPx) {
    var t = SS.corridor.tileXY(lat, lon, rc.zoom);
    var first = plan.tiles[0];
    var cx = (t.x - first.x) * rc.tileSize;
    var cy = (t.y - first.y) * rc.tileSize;
    if (cx < 0 || cy < 0 || cx >= plan.w || cy >= plan.h) return false;
    for (var dy = -radiusPx; dy <= radiusPx; dy += 5) {
      for (var dx = -radiusPx; dx <= radiusPx; dx += 5) {
        var x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= plan.w || y >= plan.h) continue;
        if (echoAt(imgData.data, (y * plan.w + x) * 4, rc.echoAlphaThreshold)) return true;
      }
    }
    return false;
  }

  function analyzeRadar(lat, lon, sunsetAzimuthDeg, options) {
    SS.network.throwIfAborted(options && options.signal);
    if (!SS.modelConfig.nowcast.enabled || !SS.modelConfig.nowcast.radar.enabled) return Promise.resolve(null);
    var rc = SS.modelConfig.nowcast.radar;
    var cor = SS.corridor;
    var evo = SS.modelConfig.evolution;
    return fetchRadarFrames(options).then(function (frameInfo) {
      var frames = frameInfo.frames;
      var plan = cor.tilePlan(lat, lon, rc.coverRadiusKm, rc.zoom, rc.tileSize);
      if (!plan) return null;
      var urlFn = function (frame) {
        return function (x, y) {
          return frameInfo.host + frame.path + '/' + rc.tileSize + '/' + rc.zoom + '/' +
            x + '/' + y + '/2/1_1.png';
        };
      };
      return Promise.all(frames.map(function (f) {
        return cor.loadTileCanvas(plan.tiles, plan.w, plan.h, urlFn(f), options);
      })).then(function (imgs) {
        var mask = cor.sectorSample(plan, lat, lon, sunsetAzimuthDeg,
          evo.corridor.maxDistanceKm, evo.corridor.azimuthHalfWidth, rc.zoom, rc.tileSize, 3);
        if (!mask.idx.length) return null;

        function echoTest(d, off) { return echoAt(d, off, rc.echoAlphaThreshold); }

        /* V2.0：各帧走廊覆盖率序列（演化引擎输入） */
        var coverageSeries = frames.map(function (f, i) {
          return { t: f.time * 1000, pct: cor.coverageAt(imgs[i].data.data, mask, echoTest) };
        }).filter(function (s) { return s.pct != null; });
        if (coverageSeries.length < 2) return null;

        var latest = imgs[imgs.length - 1], prev = imgs[imgs.length - 2];
        var last = coverageSeries[coverageSeries.length - 1];
        var secondLast = coverageSeries[coverageSeries.length - 2];
        var covPctT = last.pct, covPctPrev = secondLast.pct;
        var dtMin = (last.t - secondLast.t) / 60000;
        if (!(dtMin > 0)) return null;

        /* 质心位移（最新两帧）→ 速度向量；同时统计回波平均强度（方案 6.1 输入） */
        var velocity = null, direction = null;
        var sx = 0, sy = 0, sn = 0, sxp = 0, syp = 0, snp = 0;
        var intSum = 0, intN = 0, k, off;
        for (k = 0; k < mask.idx.length; k++) {
          off = mask.idx[k];
          if (echoAt(latest.data.data, off, rc.echoAlphaThreshold)) {
            sx += (off / 4) % plan.w; sy += Math.floor(off / 4 / plan.w); sn++;
            intSum += Math.max(latest.data.data[off], latest.data.data[off + 1], latest.data.data[off + 2]);
            intN++;
          }
          if (echoAt(prev.data.data, off, rc.echoAlphaThreshold)) {
            sxp += (off / 4) % plan.w; syp += Math.floor(off / 4 / plan.w); snp++;
          }
        }
        var intensity = intN > 0 ? Math.round(intSum / intN) : 0;
        if (sn >= 8 && snp >= 8) {
          var mpp = cor.metersPerPixelKm(lat, rc.zoom);
          var dxKm = (sx / sn - sxp / snp) * mpp;
          var dyKmCanvas = (sy / sn - syp / snp) * mpp; /* 画布 y 向下，地理北为正 */
          velocity = { dxKm: dxKm / dtMin, dyKm: -dyKmCanvas / dtMin };
          direction = (Math.atan2(velocity.dxKm, velocity.dyKm) / rad + 360) % 360;
        }

        /* ClearingVelocity：走廊回波覆盖率变化（%/min，正 = 正在清空） */
        var clearingVelocity = (covPctPrev - covPctT) / dtMin;

        /* RainArrivalRisk：沿运动反方向上游 60/120/180km 存在回波 → 预计进入时间 */
        var arrivalMin = null, risk = 'NONE';
        if (velocity) {
          var speed = Math.sqrt(velocity.dxKm * velocity.dxKm + velocity.dyKm * velocity.dyKm);
          if (speed > 0.05) {
            var azMove = (Math.atan2(velocity.dxKm, velocity.dyKm) / rad + 360) % 360;
            for (k = 1; k <= 3 && arrivalMin == null; k++) {
              var distKm = k * 60;
              var upAz = (azMove + 180) % 360;
              var sp = SS.data.destinationPoint(lat, lon, upAz, distKm);
              if (hasEchoNear(latest.data, plan, sp.latitude, sp.longitude, rc, 20)) {
                arrivalMin = Math.round(distKm / speed);
              }
            }
            if (arrivalMin != null) {
              risk = arrivalMin <= rc.riskThresholds.high ? 'HIGH'
                : arrivalMin <= rc.riskThresholds.medium ? 'MEDIUM' : 'LOW';
            }
          }
        }

        /* 雷达评分（−100~100）：趋势诊断字段，V2.0 演化引擎不使用 */
        var trendScore = clamp(clearingVelocity * 20, -50, 50); /* [TUNE] */
        var riskScore = risk === 'HIGH' ? -50 : risk === 'MEDIUM' ? -25 : risk === 'LOW' ? -10 : 0;
        if (covPctT < 5 && risk === 'NONE') riskScore = 20; /* 走廊无回波 */
        var score = clamp(trendScore + riskScore, -100, 100);

        return {
          available: true,
          source: 'rainviewer',
          coveragePct: Math.round(covPctT),
          clearingVelocity: Math.round(clearingVelocity * 100) / 100,
          arrivalMin: arrivalMin,
          risk: risk,
          dtMin: Math.round(dtMin),
          score: score,
          /* V2.0 演化输入（方案 6.1 节：coveragePct / velocity / intensity / direction） */
          coverageSeries: coverageSeries.map(function (s) {
            return { t: s.t, pct: Math.round(s.pct * 10) / 10 };
          }),
          intensity: intensity,
          direction: direction != null ? Math.round(direction) : null
        };
      });
    });
  }

  /* ---------- Source 3：卫星（NASA GIBS，Phase 3） ---------- */

  /* 按观测点经度选静止卫星候选图层列表（V1.9.1：图层名随 GIBS 产品变动，逐个探测） */
  function pickSatelliteCandidates(lon) {
    var layers = SS.modelConfig.nowcast.satellite.layers;
    var keys = ['himawari', 'goesEast', 'goesWest'];
    for (var i = 0; i < keys.length; i++) {
      var l = layers[keys[i]];
      if (lon >= l.lonMin && lon <= l.lonMax) return l.candidates;
    }
    return layers.himawari.candidates;
  }

  /* 从 WMTS Capabilities 中解析单个图层的可用时刻 */
  function parseLayerTimes(xml, layer) {
    var times = [];
    var li = xml.indexOf('>' + layer + '<');
    if (li < 0) li = xml.indexOf('"' + layer + '"');
    if (li < 0) return times;
    var seg = xml.slice(li, li + 300000);
    var dimIdx = seg.indexOf('<Dimension>');
    if (dimIdx < 0) return times;
    var seg2 = seg.slice(dimIdx, dimIdx + 200000);
    var dimEnd = seg2.indexOf('</Dimension>');
    if (dimEnd >= 0) seg2 = seg2.slice(0, dimEnd);
    var re = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/g;
    var m, seen = {};
    while ((m = re.exec(seg2)) !== null && times.length < 60) {
      if (!seen[m[1]]) { seen[m[1]] = true; times.push(m[1]); }
    }
    return times;
  }

  /* 从 Capabilities 中解析图层的 TileMatrixSet 标识。
     GIBS 各图层支持的 TMS 不同（如 Band3_Red_Visible 只支持 GoogleMapsCompatible_Level7），
     用错 TMS 会返回 400 */
  function parseLayerTileMatrixSet(xml, layerIdx) {
    var seg = xml.slice(layerIdx, layerIdx + 300000);
    var linkIdx = seg.indexOf('<TileMatrixSetLink>');
    if (linkIdx < 0) return 'GoogleMapsCompatible_Level9';
    var tmsIdx = seg.indexOf('<TileMatrixSet>', linkIdx);
    var tmsEnd = seg.indexOf('</TileMatrixSet>', tmsIdx);
    if (tmsIdx < 0 || tmsEnd < 0) return 'GoogleMapsCompatible_Level9';
    return seg.slice(tmsIdx + '<TileMatrixSet>'.length, tmsEnd);
  }

  /* 从候选图层中找到第一个在 Capabilities 中存在且有 ≥3 个时刻的（V2.0 三帧演化），
     同时解析该图层的 TileMatrixSet（修复 V1.9 硬编码 Level9 导致 400 的问题） */
  function fetchSatelliteTimes(candidates, options) {
    return SS.network.text(SS.modelConfig.nowcast.satellite.capabilities,
      Object.assign({ timeoutMs: SS.modelConfig.network.observationTimeoutMs }, options)).then(function (xml) {
      for (var ci = 0; ci < candidates.length; ci++) {
        var li = xml.indexOf('>' + candidates[ci] + '<');
        if (li < 0) li = xml.indexOf('"' + candidates[ci] + '"');
        if (li < 0) continue;
        var times = parseLayerTimes(xml, candidates[ci]);
        if (times.length >= 3) {
          times.sort();
          var n = times.length;
          return {
            layer: candidates[ci],
            times: [times[n - 3], times[n - 2], times[n - 1]],
            tileMatrixSet: parseLayerTileMatrixSet(xml, li)
          };
        }
      }
      throw new Error('候选卫星图层均不可用');
    });
  }

  function analyzeSatellite(lat, lon, sunsetAzimuthDeg, options) {
    SS.network.throwIfAborted(options && options.signal);
    if (!SS.modelConfig.nowcast.enabled || !SS.modelConfig.nowcast.satellite.enabled) return Promise.resolve(null);
    var sc = SS.modelConfig.nowcast.satellite;
    var cor = SS.corridor;
    var evo = SS.modelConfig.evolution;
    return fetchSatelliteTimes(pickSatelliteCandidates(lon), options).then(function (pair) {
      var plan = cor.tilePlan(lat, lon, sc.coverRadiusKm, sc.zoom, sc.tileSize);
      if (!plan) return null;
      var urlFn = function (time, ext) {
        return function (x, y) {
          /* WMTS REST：{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.ext */
          return sc.tileBase + '/' + pair.layer + '/default/' + time + '/' +
            pair.tileMatrixSet + '/' + sc.zoom + '/' + y + '/' + x + '.' + ext;
        };
      };
      /* 瓦片格式随图层而异：先试 jpg，失败回退 png */
      function loadFrames(ext) {
        return Promise.all(pair.times.map(function (t) {
          return cor.loadTileCanvas(plan.tiles, plan.w, plan.h, urlFn(t, ext), options);
        }));
      }
      return loadFrames('jpg').catch(function () { SS.network.throwIfAborted(options && options.signal); return loadFrames('png'); }).then(function (imgs) {
        var mask = cor.sectorSample(plan, lat, lon, sunsetAzimuthDeg,
          evo.corridor.maxDistanceKm, evo.corridor.azimuthHalfWidth, sc.zoom, sc.tileSize, 4);
        if (!mask.idx.length) return null;

        function cloudAt(d, off) {
          var r = d[off], g = d[off + 1], b = d[off + 2];
          var lum = 0.299 * r + 0.587 * g + 0.114 * b;
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          return lum >= sc.cloudLumThreshold && (mx - mn) <= sc.cloudSatMax;
        }

        /* V2.0：各帧走廊云覆盖率序列（演化输入） */
        var coverageSeries = pair.times.map(function (t, i) {
          return { t: Date.parse(t), pct: cor.coverageAt(imgs[i].data.data, mask, cloudAt) };
        }).filter(function (s) { return s.pct != null; });
        if (coverageSeries.length < 2) return null;

        /* 距离分层覆盖率（方案 8.3 节：Near 0-30 / Middle 30-100 / Far 100-250） */
        var bands = cor.coverageByBands(imgs[imgs.length - 1].data.data, mask, [
          { name: 'near', minKm: 0, maxKm: 30 },
          { name: 'middle', minKm: 30, maxKm: 100 },
          { name: 'far', minKm: 100, maxKm: evo.corridor.maxDistanceKm + 1 }
        ], cloudAt);

        var last = coverageSeries[coverageSeries.length - 1];
        var secondLast = coverageSeries[coverageSeries.length - 2];
        var covPctT = last.pct, covPctPrev = secondLast.pct;
        var dtMin = (last.t - secondLast.t) / 60000;
        if (!(dtMin > 0)) return null;
        var trendPctPerMin = (covPctPrev - covPctT) / dtMin; /* 正 = 走廊云正在减少 */

        /* HighCloudPotential：走廊薄云覆盖率接近最佳中心时高分 [TUNE]（趋势诊断字段） */
        var highCloudPotential = gauss(covPctT, sc.highCloudCenter, sc.highCloudWidth);
        /* CloudArrivalRisk：覆盖率正在上升且速度偏快 → 云正在进入走廊（趋势诊断字段） */
        var cloudRisk = trendPctPerMin <= -0.5 ? 'HIGH' : trendPctPerMin <= -0.1 ? 'MEDIUM' : 'LOW';

        var trendScore = clamp(trendPctPerMin * 8, -40, 40); /* [TUNE] */
        var potentialScore = (highCloudPotential - 50) * 0.6; /* 50 为中性，±30 */
        var riskScore = cloudRisk === 'HIGH' ? -30 : cloudRisk === 'MEDIUM' ? -15 : 10;
        var score = clamp(trendScore + potentialScore + riskScore, -100, 100);

        return {
          available: true,
          layer: pair.layer,
          coveragePct: Math.round(covPctT),
          trendPctPerMin: Math.round(trendPctPerMin * 100) / 100,
          highCloudPotential: Math.round(highCloudPotential),
          cloudRisk: cloudRisk,
          dtMin: Math.round(dtMin),
          score: score,
          /* V2.0 演化输入（方案 8 章） */
          coverageSeries: coverageSeries.map(function (s) {
            return { t: s.t, pct: Math.round(s.pct * 10) / 10 };
          }),
          bandCoverage: bands
        };
      });
    });
  }

  /* ---------- 融合引擎（方案 7-8 章） ---------- */

  /**
   * @param sources {forecastTrend(-100~100), precip(分析结果|null), radar(分析结果|null), satellite(分析结果|null)}
   * @returns 融合结果；全部源缺失时返回 null（调用方按 V1.8 处理）
   */
  function fuse(sources) {
    var w = SS.modelConfig.nowcast.weights;
    var limit = SS.modelConfig.nowcast.trendScale;
    var parts = [], wsum = 0;

    if (valid(sources.forecastTrend)) {
      parts.push({ key: 'forecast', value: clamp(sources.forecastTrend, -100, 100) / 100, weight: w.forecast });
    }
    if (sources.precip && sources.precip.available) {
      parts.push({ key: 'precip', value: clamp(sources.precip.rainClearScore / 40, -1, 1), weight: w.precip });
    }
    if (sources.radar && sources.radar.available) {
      parts.push({ key: 'radar', value: sources.radar.score / 100, weight: w.radar });
    }
    if (sources.satellite && sources.satellite.available) {
      parts.push({ key: 'satellite', value: sources.satellite.score / 100, weight: w.satellite });
    }
    parts.forEach(function (p) { wsum += p.weight; });
    if (!parts.length || wsum <= 0) return null;

    var combined = 0;
    parts.forEach(function (p) { combined += p.value * (p.weight / wsum); });
    var modifier = Math.round(clamp(combined * limit, -limit, limit));
    var nowcastScore = Math.round((combined + 1) / 2 * 100);

    var trend = modifier >= 4 ? 'OPENING' : modifier <= -4 ? 'APPROACHING' : 'STABLE';

    /* 黄金窗口动态状态（方案 10 章）：以分钟级雨停时间为主 */
    var goldenWindow = null;
    var pr = sources.precip;
    if (pr && pr.available && pr.rainingNow && pr.stopTimeMs != null) {
      var durMin = pr.nextRainMs != null
        ? Math.round((pr.nextRainMs - pr.stopTimeMs) / 60000)
        : (valid(pr.coverageEndMs) ? Math.floor((pr.coverageEndMs - pr.stopTimeMs) / 60000) : 120);
      goldenWindow = { stopTimeMs: pr.stopTimeMs, durationMin: Math.max(0, durMin) };
    }

    return {
      nowcastScore: nowcastScore,
      trend: trend,
      goldenWindow: goldenWindow,
      sources: parts.map(function (p) { return p.key; }),
      clearTimeMs: (pr && pr.stopTimeMs) || null,
      cloudRisk: sources.radar ? sources.radar.risk
        : (sources.satellite ? sources.satellite.cloudRisk : 'NONE')
    };
  }

  /* ---------- 对外接口 ---------- */

  SS.nowcast = {
    fetchMinutePrecip: fetchMinutePrecip,
    precipAtSeries: precipAtSeries,
    buildTimeline: buildTimeline,
    analyzePrecip: analyzePrecip,
    analyzeRadar: analyzeRadar,
    analyzeSatellite: analyzeSatellite,
    fuse: fuse,

    /**
     * 汇总执行：任一源失败静默降级。forecastTrend 由 app.js 从小时预报计算传入。
     * @returns {Promise<Object|null>}
     */
    run: function (ctx, options) {
      options = options || {};
      SS.network.throwIfAborted(options.signal);
      /* ctx: {lat, lon, dateStr, nowUtc, sunsetAzimuthDeg, forecastTrend, utcOffsetSeconds} */
      var nowcastConfig = SS.modelConfig.nowcast;
      var ttl = nowcastConfig.ttlMinutes;

      function cached(type, fetcher) {
        if (!nowcastConfig.enabled || (type !== 'precip' && !nowcastConfig[type].enabled)) {
          return Promise.resolve({ analysis: null, status: 'DISABLED', error: null });
        }
        var key = SS.cacheKeys.nowcast(type, ctx.dateStr, ctx.lat, ctx.lon);
        var fresh = SS.cache.get(key);
        if (fresh) return Promise.resolve(fresh);
        return SS.network.run(function (signal) {
          return fetcher({ signal: signal });
        }, { signal: options.signal, timeoutMs: SS.modelConfig.network.sourceTimeoutMs }).then(function (v) {
          SS.network.throwIfAborted(options.signal);
          if (v) SS.cache.set(key, v, ttl[type]);
          return v;
        }).catch(function (error) {
          SS.network.throwIfAborted(options.signal);
          return { analysis: null, status: error.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED', error: error.message };
        });
      }

      return Promise.all([
        cached('precip', function (sourceOptions) {
          return fetchMinutePrecip(ctx.lat, ctx.lon, sourceOptions).then(function (series) {
            var a = analyzePrecip(series, ctx.nowUtc.valueOf());
            return { analysis: a, status: a ? 'OK' : 'NO_DATA', error: a ? null : '无分钟级降水' };
          }).catch(function (err) {
            SS.network.throwIfAborted(sourceOptions.signal);
            return { analysis: null, status: err.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED', error: err.message || '降水接口异常' };
          });
        }),
        cached('radar', function (sourceOptions) {
          /* 瓦片分析依赖 canvas：非浏览器环境与全瓦片失败记录诊断信息；
             失败也缓存空结果（TTL 内负缓存），避免对不可用源反复重试 */
          if (typeof document === 'undefined') {
            return Promise.resolve({ analysis: null, status: 'UNAVAILABLE', error: '非浏览器环境' });
          }
          return analyzeRadar(ctx.lat, ctx.lon, ctx.sunsetAzimuthDeg, sourceOptions)
            .then(function (a) {
              return { analysis: a, status: a ? 'OK' : 'EMPTY', error: a ? null : '区域无雷达回波覆盖' };
            })
            .catch(function (err) {
              SS.network.throwIfAborted(sourceOptions.signal);
              return { analysis: null, status: err.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED', error: err && err.message ? err.message : '雷达瓦片获取失败' };
            });
        }),
        cached('satellite', function (sourceOptions) {
          if (typeof document === 'undefined') {
            return Promise.resolve({ analysis: null, status: 'UNAVAILABLE', error: '非浏览器环境' });
          }
          return analyzeSatellite(ctx.lat, ctx.lon, ctx.sunsetAzimuthDeg, sourceOptions)
            .then(function (a) {
              return { analysis: a, status: a ? 'OK' : 'EMPTY', error: a ? null : '区域无卫星有效数据' };
            })
            .catch(function (err) {
            SS.network.throwIfAborted(sourceOptions.signal);
              return { analysis: null, status: err.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED', error: err && err.message ? err.message : '卫星瓦片获取失败' };
            });
        })
      ]).then(function (res) {
        var precipRes = res[0] || {};
        var radarRes = res[1] || {};
        var satRes = res[2] || {};

        var precip = precipRes.analysis || null;
        var radar = radarRes.analysis || null;
        var satellite = satRes.analysis || null;

        var fusion = fuse({
          forecastTrend: ctx.forecastTrend,
          precip: precip, radar: radar, satellite: satellite
        });
        if (!fusion) fusion = { sources: [], trend: 'STABLE', nowcastScore: null, goldenWindow: null, clearTimeMs: null, cloudRisk: 'NONE' };

        fusion.sourcesStatus = {
          qweather: { available: !!precip && precip.source === 'qweather',
            status: !nowcastConfig.enabled || !nowcastConfig.qweather.enabled ? 'DISABLED'
              : (precip && precip.source === 'qweather' ? 'OK' : 'FALLBACK_OR_UNAVAILABLE'), error: null },
          precip: { available: !!precip, status: precipRes.status || (precip ? 'OK' : 'FAILED'), error: precipRes.error || null },
          radar: { available: !!radar, status: radarRes.status || (radar ? 'OK' : 'FAILED'), error: radarRes.error || null },
          satellite: { available: !!satellite, status: satRes.status || (satellite ? 'OK' : 'FAILED'), error: satRes.error || null }
        };

        fusion.detail = {
          // Preserve the analysis contract, including available, series and stop/next-rain times.
          precip: precip,
          radar: radar,
          satellite: satellite,
          sourcesStatus: fusion.sourcesStatus,
          offsetSeconds: ctx.utcOffsetSeconds
        };
        return fusion;
      });
    },

    /* 供 app.js 展示：本地时刻格式化 */
    fmtHM: fmtHM
  };
})(typeof window !== 'undefined' ? window : globalThis);
