/* ============================================================
 * SunsetScore V1.7 - 评分引擎
 *
 * V1.8：数据层优化（Batch/采样/缓存），Engine 仅新增采样与缓存
 *   元信息输出（sampling_mode / spatial_completeness / data_freshness 等），
 *   评分公式、权重与 Regime 逻辑保持不变。
 * V1.7 公式（weatherRegimeV17.enabled=true）：
 *   Score = Clamp[ (Σ component_i × DynamicWeight_i) × Q × G_H
 *                  + B_structure + B_transition − P_weather, 0, 100 ]
 * V1.61 原公式（enabled=false 回退）：
 *   Score = Clamp[ P × Q × G_H + B_regime − P_weather, 0, 100 ]
 *   P = 0.30·SkyCanvas + 0.20·Horizon + 0.20·Illumination
 *       + 0.20·Atmosphere + 0.10·Weather
 *   Q = 0.70 + 0.30·(Atmosphere/100)
 *
 * V1.7 Weather Regime 动态权重升级：
 *   - Regime 强度检测（RegimeStrength）与 WeatherScore 重构
 *   - Dynamic Weight Controller：FinalWeight = BaseWeight × RegimeMultiplier
 *     （按 strength 插值，Weather 权重取下限后归一）
 *   - Regime Transition 趋势模型与 TransitionBonus
 *   - 天气型直接加分（regimeBonus/clearingBonus）移除，
 *     改由强度、动态权重与过渡加分承接
 *
 * V1.6 Spatial Cloud Field 升级：
 *   - 距离分带改为半开区间，修复边界重复计入
 *   - 分区语义：Sunset Corridor(0°) / Cloud Bank(±30°) / Side Sky(待扩展)
 *   - 角向非对称权重 W = cos(offset)^power
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  /* ---------- 通用工具 ---------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function valid(v) { return typeof v === 'number' && isFinite(v); }
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
  function stdDev(arr) {
    var m = avg(arr);
    if (m == null) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }
  function weightedMean(items) {
    /* items: [{value, weight}]，缺失值时按可用权重重新归一 */
    var sum = 0, wsum = 0;
    items.forEach(function (it) {
      if (valid(it.value)) { sum += it.weight * it.value; wsum += it.weight; }
    });
    return wsum > 0 ? sum / wsum : null;
  }

  /* ---------- V1.6 空间工具 ---------- */

  /* 半开区间距离分带：[0,50) near / [50,100) medium / [100,200) far / [200,300] veryFar。
     修复 V1.5 闭区间导致 50/100/200km 节点重复计入相邻两带的问题（方案二章） */
  function getDistanceBand(distanceKm) {
    if (distanceKm < 50) return 'near';
    if (distanceKm < 100) return 'medium';
    if (distanceKm < 200) return 'far';
    return 'veryFar';
  }

  /* 角向非对称权重：中心方向视觉贡献大于两侧（方案四章） */
  function angularWeight(offsetDeg, power) {
    var r = offsetDeg * Math.PI / 180;
    return Math.pow(Math.cos(r), power);
  }

  /* 分区映射：0° → corridor（日落走廊），±30° → cloudBank（云幕区）。
     Side Sky（45°~90°）暂无采样点，为未来扩展保留（方案 3.2 节） */
  function getSector(azimuthOffset) {
    if (azimuthOffset === 0) return 'corridor';
    return 'cloudBank';
  }

  /* ---------- 时间序列定位 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 伪当地 Date → 'YYYY-MM-DDTHH:00' 当地时间字符串 */
  function localKey(localShiftedDate) {
    return localShiftedDate.getUTCFullYear() + '-' + pad2(localShiftedDate.getUTCMonth() + 1) +
      '-' + pad2(localShiftedDate.getUTCDate()) + 'T' + pad2(localShiftedDate.getUTCHours()) + ':00';
  }

  /* 在 forecast.hourly.time（当地 ISO 字符串）中找最接近 target 的小时索引 */
  function hourIndex(times, localShiftedDate) {
    var targetMs = Date.parse(localKey(localShiftedDate));
    var best = -1, bestDiff = Infinity;
    for (var i = 0; i < times.length; i++) {
      var diff = Math.abs(Date.parse(times[i]) - targetMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  /* 读取某采样点某小时的变量 */
  function sampleAt(forecast, idx) {
    var h = forecast.hourly;
    function at(key) { return h[key] ? h[key][idx] : null; }
    return {
      cloud: at('cloud_cover'),
      low: at('cloud_cover_low'),
      mid: at('cloud_cover_mid'),
      high: at('cloud_cover_high'),
      visM: at('visibility'),
      rh: at('relative_humidity_2m'),
      precip: at('precipitation'),
      precipProb: at('precipitation_probability'),
      wind: at('wind_speed_10m'),
      pressure: at('surface_pressure')
    };
  }

  /* ---------- 各组件评分 ---------- */

  function cloudScores(v, cfg) {
    return {
      high: valid(v.high) ? gauss(v.high, cfg.highCloudCenter, cfg.highCloudWidth) : null,
      mid: valid(v.mid) ? gauss(v.mid, cfg.midCloudCenter, cfg.midCloudWidth) : null,
      lowGood: valid(v.low) ? clamp(100 - v.low, 0, 100) : null,      /* 低云少 = 好 */
      opening: valid(v.low) ? clamp(1 - v.low / 100, 0, 1) : null     /* 第 10.1 节 */
    };
  }

  /* 主计算入口
   * input: {
   *   location, utcOffsetSeconds, localNowUtc(Date),
   *   solar {sunset, civilDusk, sunsetAzimuthDeg, twilightMinutes},
   *   sunsetLocal(伪当地 Date), samples [{point, forecast}],
   *   air (AQ 响应|null), expectedSampleCount,
   *   V1.8 可选元信息：spatialCompleteness(0~1), samplingMode,
   *   cacheStatus('FRESH'|'STALE'|'MISS'), dataAgeMinutes, escalated, escalationReason
   * } */
  function compute(input) {
    var cfg = SS.config;

    /* ===== 定位分析时刻 ===== */
    var localSample = null;
    for (var i = 0; i < input.samples.length; i++) {
      if (input.samples[i].point.distanceKm === 0) { localSample = input.samples[i]; break; }
    }
    if (!localSample || !localSample.forecast) throw new Error('本地天气数据缺失');

    var times = localSample.forecast.hourly.time;
    var idx = hourIndex(times, input.sunsetLocal);
    var nowIdx = hourIndex(times, SS.data.toLocalShifted(input.localNowUtc, input.utcOffsetSeconds));

    var lv = sampleAt(localSample.forecast, idx);
    var ls = cloudScores(lv, cfg);

    function valueAt(sample, key) {
      if (!sample.forecast) return null;
      var j = hourIndex(sample.forecast.hourly.time, input.sunsetLocal);
      return sampleAt(sample.forecast, j)[key];
    }
    function scoresAt(sample) {
      if (!sample.forecast) return null;
      var j = hourIndex(sample.forecast.hourly.time, input.sunsetLocal);
      return cloudScores(sampleAt(sample.forecast, j), cfg);
    }

    /* ===== 9. Sky Canvas ===== */
    var canvas = cfg.canvasWeights.high * (ls.high || 0) +
      cfg.canvasWeights.mid * (ls.mid || 0) +
      cfg.canvasWeights.low * (ls.lowGood || 0);

    var farVals = input.samples
      .filter(function (s) { return s.point.distanceKm >= cfg.farCloudMinKm; })
      .map(function (s) {
        var sc = scoresAt(s);
        if (!sc || (sc.high == null && sc.mid == null)) return null;
        return 0.6 * (sc.high || 0) + 0.4 * (sc.mid || 0);
      })
      .filter(valid);
    var farCloud = farVals.length ? avg(farVals) : canvas;

    var localCompat = (ls.high != null && ls.lowGood != null)
      ? 0.5 * ls.high + 0.5 * ls.lowGood : canvas;

    var skyCanvas = cfg.skyCanvasWeights.canvas * canvas +
      cfg.skyCanvasWeights.far * farCloud +
      cfg.skyCanvasWeights.localCompat * localCompat;

    /* ===== 10-11. Horizon + Gate（V1.6：分区加权 + 角权重） ===== */
    var sf = cfg.spatialFieldV16;
    var bySector = { corridor: [], cloudBank: [], side: [] };
    input.samples.forEach(function (s) {
      var sc = scoresAt(s);
      if (!sc || sc.opening == null) return;
      /* 同一方位上先按 V1.5 距离权重表聚合，再乘以角权重 cos(offset)^power */
      var sector = getSector(s.point.azimuthOffset);
      bySector[sector].push({
        d: s.point.distanceKm,
        offset: s.point.azimuthOffset,
        o: sc.opening
      });
    });
    function sectorOpening(nodes) {
      if (!nodes.length) return null;
      /* 按方位角分组：组内距离加权，组间角权重加权 */
      var byOffset = {};
      nodes.forEach(function (it) {
        (byOffset[it.offset] = byOffset[it.offset] || []).push(it);
      });
      var items = Object.keys(byOffset).map(function (off) {
        var distItems = byOffset[off].map(function (it) {
          return { value: it.o * 100, weight: cfg.horizonDistanceWeights[it.d] || 0.1 };
        });
        return {
          value: weightedMean(distItems),
          weight: angularWeight(Number(off), sf.angularPower)
        };
      });
      return weightedMean(items);
    }
    var corridorOpening = sectorOpening(bySector.corridor);
    var bankOpening = sectorOpening(bySector.cloudBank);
    var sideOpening = sectorOpening(bySector.side);
    /* Side Sky 暂无数据时，走廊/云幕权重重新归一（0.6/0.3 → 0.667/0.333） */
    var horizon = weightedMean([
      { value: corridorOpening, weight: sf.sectorWeights.corridor },
      { value: bankOpening, weight: sf.sectorWeights.bank },
      { value: sideOpening, weight: sf.sectorWeights.side }
    ]);
    if (horizon == null) horizon = 50;
    var gate = 1.0;
    for (var g = 0; g < cfg.horizonGate.length; g++) {
      if (horizon >= cfg.horizonGate[g].min) { gate = cfg.horizonGate[g].gate; break; }
    }

    /* ===== 12. Illumination（V1.6：半开区间分带 + 预报可信度） ===== */
    /* 太阳角度因子：民用昏影越长，低角度照射云层的时间越充分 */
    var solarAngleScore = 30 + 70 * clamp(input.solar.twilightMinutes / 35, 0, 1);

    var spatialSum = 0, spatialW = 0, confSum = 0;
    Object.keys(sf.distanceBands).forEach(function (bandName) {
      var inBand = input.samples.filter(function (s) {
        return getDistanceBand(s.point.distanceKm) === bandName;
      });
      var vals = inBand.map(function (s) {
        var sc = scoresAt(s);
        if (!sc || sc.high == null || sc.mid == null) return null;
        return 0.65 * sc.high + 0.35 * sc.mid;   /* 第 12.2 节 CIP */
      }).filter(valid);
      if (vals.length) {
        /* CloudPotential = DistanceWeight × ForecastConfidence × CloudTypeScore */
        var conf = sf.forecastConfidence[bandName] || 1;
        var w = sf.distanceBands[bandName] * conf;
        spatialSum += w * avg(vals);
        spatialW += w;
        confSum += sf.distanceBands[bandName] * conf;
      }
    });
    var spatialCompat = spatialW > 0 ? spatialSum / spatialW : canvas;
    /* DistanceConfidence：按实际贡献归一后的分带预报可信度 */
    var distanceConfidence = confSum > 0
      ? spatialW / confSum
      : (sf.forecastConfidence.far || 0.75);

    /* ===== V1.6 Cloud Bank 云幕识别模型（方案五章） ===== */
    /* 高中云"在哪"比"多少"更重要：识别云是否集中在太阳附近且不遮挡核心方向 */
    var bankCfg = sf.cloudBank;
    var centerVals = [], sideVals = [];
    input.samples.forEach(function (s) {
      var hm = valueAt(s, 'high');
      var md = valueAt(s, 'mid');
      if (!valid(hm) || !valid(md)) return;
      var hmSum = hm + md;
      if (s.point.azimuthOffset === 0) centerVals.push(hmSum);
      else sideVals.push(hmSum);
    });
    var centerCloudRaw = centerVals.length ? avg(centerVals) : null;
    var sideCloudRaw = sideVals.length ? avg(sideVals) : null;
    var contrastRaw = (centerCloudRaw != null && sideCloudRaw != null)
      ? centerCloudRaw - sideCloudRaw : null;

    /* CenterCloud：走廊节点高中云评分的角权重均值 */
    var centerScore = weightedMean(input.samples
      .filter(function (s) { return s.point.azimuthOffset === 0; })
      .map(function (s) {
        var sc = scoresAt(s);
        if (!sc || sc.high == null || sc.mid == null) return null;
        return {
          value: 0.65 * sc.high + 0.35 * sc.mid,
          weight: angularWeight(0, sf.angularPower)
        };
      })
      .filter(function (it) { return it !== null; }));

    /* ContrastBonus：中心比两侧明显时奖励（文档示例：contrast=70 → +20），
       归一到 0-100 参与加权 */
    var contrastBonus = valid(contrastRaw)
      ? clamp(contrastRaw / bankCfg.contrastFull, 0, 1) * bankCfg.contrastBonusMax
      : null;
    var contrastScoreNorm = contrastBonus != null
      ? contrastBonus / bankCfg.contrastBonusMax * 100 : null;

    /* DistanceScore：远方云幕价值更高（50→0.2 … 300→1.0） */
    var distanceScore = weightedMean(input.samples
      .filter(function (s) { return s.point.distanceKm > 0; })
      .map(function (s) {
        var sc = scoresAt(s);
        if (!sc || sc.high == null || sc.mid == null) return null;
        return {
          value: 0.65 * sc.high + 0.35 * sc.mid,
          weight: sf.distanceBonus[s.point.distanceKm] || 0.2
        };
      })
      .filter(function (it) { return it !== null; }));

    var bankScore = weightedMean([
      { value: centerScore, weight: bankCfg.centerWeight },
      { value: contrastScoreNorm, weight: bankCfg.contrastWeight },
      { value: distanceScore, weight: bankCfg.distanceWeight }
    ]);
    if (bankScore == null) bankScore = canvas;

    /* ===== V1.61 Cloud Continuity（增强方案 4.2 节） ===== */
    /* 沿每个方位角的距离链（50→100→200→300km）计算相邻相似度，
       替换 V1.6 的全扇区 stdDev 版本（文档给出正式定义） */
    var sf61 = cfg.spatialFieldV161;
    function cloudPotentialAt(sample) {
      var hm = valueAt(sample, 'high');
      var md = valueAt(sample, 'mid');
      if (!valid(hm) || !valid(md)) return null;
      return sf61.continuity.midWeight * md + sf61.continuity.highWeight * hm;
    }
    var chainContinuities = [];
    cfg.azimuthOffsets.forEach(function (offset) {
      var chain = cfg.distancesKm
        .map(function (dist) {
          var sample = null;
          for (var si = 0; si < input.samples.length; si++) {
            var p = input.samples[si].point;
            if (p.distanceKm === dist && p.azimuthOffset === offset) { sample = input.samples[si]; break; }
          }
          return sample ? cloudPotentialAt(sample) : null;
        });
      var sims = [];
      for (var ci = 0; ci < chain.length - 1; ci++) {
        if (chain[ci] != null && chain[ci + 1] != null) {
          sims.push(1 - Math.abs(chain[ci] - chain[ci + 1]) / 100);
        }
      }
      if (sims.length) chainContinuities.push(avg(sims) * 100);
    });
    var continuity = chainContinuities.length ? avg(chainContinuities) : 50;

    /* ===== V1.61 Spatial Gradient（增强方案 4.3 节） ===== */
    /* 走廊节点远/近程云量差：正 = 前景开阔+远方云幕，负 = 云层逼近 */
    var nearVals = [], farValsG = [];
    input.samples.forEach(function (s) {
      if (s.point.azimuthOffset !== 0) return;
      var cp = cloudPotentialAt(s);
      if (cp == null) return;
      if (s.point.distanceKm <= 100) nearVals.push(cp);
      else if (s.point.distanceKm >= 200) farValsG.push(cp);
    });
    var nearCloud = nearVals.length ? avg(nearVals) : null;
    var farCloudG = farValsG.length ? avg(farValsG) : null;
    var gradientVal = (nearCloud != null && farCloudG != null) ? farCloudG - nearCloud : null;
    var gradientType = 'neutral';
    if (gradientVal != null) {
      if (gradientVal > sf61.gradient.farType) gradientType = 'far_cloud_bank';
      else if (gradientVal < sf61.gradient.nearType) gradientType = 'approaching_cloud';
    }

    /* CloudStructureScore = 0.6×Continuity + 0.4×GradientScore */
    var cloudStructureScore = sf61.structure.continuityWeight * continuity +
      sf61.structure.gradientWeight * clamp(gradientVal != null ? gradientVal : 0, 0, 100);

    /* SkyCanvas V1.61 = 0.30×Local + 0.30×CloudBank + 0.15×FarField
       + 0.15×CloudStructure + 0.10×AntiSunset（antiSunset 待 Sprint 3 替换兜底项） */
    var w161 = sf61.skyCanvasWeightsV161;
    var antiSunsetScore = canvas;
    skyCanvas = w161.local * canvas + w161.bank * bankScore +
      w161.far * farCloud + w161.structure * cloudStructureScore +
      w161.antiSunset * antiSunsetScore;

    /* 结构加分：远方连续云幕形成（方案 4.4 节） */
    var structureBonus = (gradientVal != null &&
      gradientVal > sf61.structure.bonusGradientMin &&
      continuity > sf61.structure.bonusContinuityMin)
      ? sf61.structure.bonusValue : 0;

    /* Illumination V1.6 = SolarAngle × CloudBankPotential × DistanceConfidence */
    var cloudBankPotential = 0.5 * bankScore + 0.5 * spatialCompat;
    var illumination = clamp(
      solarAngleScore * cloudBankPotential / 100 * distanceConfidence, 0, 100);

    /* ===== 13. Atmosphere ===== */
    var visKm = valid(lv.visM) ? lv.visM / 1000 : null;
    var visScore = visKm == null ? null : 100 * (1 - Math.exp(-visKm / cfg.visibilityScaleKm));

    var aod = null, pm25 = null;
    if (input.air && input.air.hourly && input.air.hourly.time) {
      var airIdx = hourIndex(input.air.hourly.time, input.sunsetLocal);
      aod = input.air.hourly.aerosol_optical_depth ? input.air.hourly.aerosol_optical_depth[airIdx] : null;
      pm25 = input.air.hourly.pm2_5 ? input.air.hourly.pm2_5[airIdx] : null;
    }
    var aodScore = valid(aod) ? gauss(aod, cfg.aodCenter, cfg.aodWidth) : null;
    var pmScore = valid(pm25) ? clamp(100 - (pm25 - 5) * (100 / 70), 0, 100) : null;
    var humScore = valid(lv.rh) ? gauss(lv.rh, cfg.humidityCenter, cfg.humidityWidth) : null;

    var atmosphere = weightedMean([
      { value: visScore, weight: cfg.atmosphereWeights.visibility },
      { value: aodScore, weight: cfg.atmosphereWeights.aod },
      { value: pmScore, weight: cfg.atmosphereWeights.pm25 },
      { value: humScore, weight: cfg.atmosphereWeights.humidity }
    ]);
    if (atmosphere == null) atmosphere = 55; /* 数据全缺时的中性兜底 */
    
    /* ===== V1.61/V2.1 Anti-Sunset Cloud ===== */
    /* V2.1 升级：若传入 360° CloudField，则提取日落方位反向 (sunsetAzimuth + 180°)
       的真实射线节点计算反日落中高云反射；未传入时回退本地高云兜底 */
    var antiHighVal = null, antiTotalVal = null;
    if (sf61.antiSunset.enabled) {
      var antiW = sf61.antiSunset.weights;
      var antiHigh = ls.high != null ? ls.high : 0;
      var sunsetField = input.cloudFieldSunset || input.cloudField;
      if (sunsetField && typeof sunsetField.getByRay === 'function') {
        var antiAzimuth = (input.solar.sunsetAzimuthDeg + 180) % 360;
        var antiRayNodes = sunsetField.getByRay(antiAzimuth);
        if (antiRayNodes && antiRayNodes.length) {
          var validHighs = [], validTotals = [];
          antiRayNodes.forEach(function (n) {
            if (n.hasData && n.data) {
              if (valid(n.data.cloud_cover_high)) validHighs.push(n.data.cloud_cover_high);
              if (valid(n.data.cloud_cover)) validTotals.push(n.data.cloud_cover);
            }
          });
          if (validHighs.length) {
            antiHigh = avg(validHighs);
            antiHighVal = Math.round(antiHigh);
          }
          if (validTotals.length) {
            antiTotalVal = Math.round(avg(validTotals));
          }
        }
      }
      var antiVis = visScore != null ? visScore : 50;
      antiSunsetScore = clamp(
        antiW.high * antiHigh + antiW.continuity * continuity + antiW.visibility * antiVis,
        0, 100);
      /* 用真实 antiSunset 项重建 SkyCanvas（完整 V1.61 权重） */
      skyCanvas = w161.local * canvas + w161.bank * bankScore +
        w161.far * farCloud + w161.structure * cloudStructureScore +
        w161.antiSunset * antiSunsetScore;
    }

    /* ===== 14-15. Weather Regime ===== */
    var lookback = cfg.rainToClearLookbackHours;
    var pastRain = 0;
    for (var k = Math.max(0, idx - lookback); k < idx; k++) {
      var p = localSample.forecast.hourly.precipitation[k];
      if (valid(p)) pastRain += p;
    }
    var curRain = valid(lv.precip) ? lv.precip : 0;
    var rainProb = valid(lv.precipProb) ? lv.precipProb : 0;
    var wind = valid(lv.wind) ? lv.wind : 0;
    var pressureDrop = 0;
    if (valid(lv.pressure)) {
      var pPrev = localSample.forecast.hourly.surface_pressure[Math.max(0, idx - 6)];
      if (valid(pPrev)) pressureDrop = pPrev - lv.pressure;
    }
    var midHigh = (valid(lv.mid) ? lv.mid : 0) + (valid(lv.high) ? lv.high : 0);

    /* 第 15 章条件③：日落方向低云开始减少。
       全部采样点都位于日落扇区（Local + 日落方位±30°），
       对比扇区平均低云量在提前 lowLead 小时前与日落时刻的变化 */
    var lowLead = cfg.rainToClearLowCloudLeadHours;
    function sectorLowAvg(offsetHours) {
      var vals = input.samples.map(function (s) {
        if (!s.forecast) return null;
        var j = hourIndex(s.forecast.hourly.time, input.sunsetLocal) + offsetHours;
        var lowSeries = s.forecast.hourly.cloud_cover_low;
        if (!lowSeries || j < 0 || j >= lowSeries.length) return null;
        return lowSeries[j];
      }).filter(valid);
      return vals.length ? avg(vals) : null;
    }
    var sectorLowEarlier = sectorLowAvg(-lowLead);
    var sectorLowLater = sectorLowAvg(0);
    var lowCloudDecreasing = sectorLowEarlier != null && sectorLowLater != null &&
      (sectorLowEarlier - sectorLowLater) >= cfg.rainToClearLowCloudDrop;

    /* 第 15 章黄金窗口：日落落在降雨结束后 30–90 分钟内。
       小时级数据分辨率为 60 分钟：雨停时刻近似为最后一个雨时的结束时刻，
       用区间重叠判断真实间隔是否可能落入黄金窗口 */
    var lastRainIdx = -1;
    for (var k2 = idx - 1; k2 >= Math.max(0, idx - lookback); k2--) {
      var pr = localSample.forecast.hourly.precipitation[k2];
      if (valid(pr) && pr >= cfg.rainToClearMinRainMm) { lastRainIdx = k2; break; }
    }
    var goldenWindowOk = false;
    /* V1.9：有分钟级雨停时刻时优先精确判定（技术方案 Phase 1），
       替代小时级近似的区间重叠判断 */
    var minuteStopMs = input.minutePrecip && input.minutePrecip.stopTimeMs;
    if (lastRainIdx >= 0 && valid(minuteStopMs)) {
      var gwMinute = cfg.rainToClearGoldenWindow;
      var gapMinute = (input.solar.sunset.valueOf() - minuteStopMs) / 60000;
      goldenWindowOk = gapMinute >= gwMinute.min && gapMinute <= gwMinute.max;
    } else if (lastRainIdx >= 0) {
      var rainEndMs = Date.parse(localSample.forecast.hourly.time[lastRainIdx + 1]);
      var gapMin = (Date.parse(localKey(input.sunsetLocal)) - rainEndMs) / 60000;
      var gw = cfg.rainToClearGoldenWindow;
      goldenWindowOk = gapMin >= gw.min && (gapMin - 60) <= gw.max;
    }

    var regime;
    if (wind >= 60 || (rainProb >= 80 && curRain >= 8)) {
      regime = 'STORM_APPROACHING';
    } else if (pastRain >= 1 && curRain < 0.3 && rainProb <= 50 && midHigh >= 30 &&
               lowCloudDecreasing && goldenWindowOk) {
      regime = 'RAIN_TO_CLEAR';
    } else if (visKm != null && visKm < 5 && valid(lv.rh) && lv.rh > 85) {
      regime = 'HAZY';
    } else if (valid(lv.cloud) && lv.cloud >= 85) {
      regime = 'OVERCAST';
    } else if (valid(lv.cloud) && lv.cloud < 20) {
      regime = 'CLEAR';
    } else if (pressureDrop >= 3 && wind >= 30) {
      regime = 'FRONT_PASSING';
    } else {
      regime = 'PARTLY_CLOUDY';
    }
    var weather = cfg.regimeScore[regime];

    /* ===== V1.61 Spatial Clearing Front（增强方案五章） ===== */
    /* 引入时间维度：各节点 T-3h 与当前的低云对比，识别清空速率与推进方向。
       凌晨时段历史小时不足时按可用长度截断并降低 confidence */
    var clrCfg = sf61.clearing;
    var histLen = Math.min(clrCfg.historyHours, Math.max(0, nowIdx));
    var clearingRates = [], clearingValid = 0;
    var nearRates = [], farRates = [];
    input.samples.forEach(function (s) {
      if (!s.forecast) return;
      var jNow = hourIndex(s.forecast.hourly.time,
        SS.data.toLocalShifted(input.localNowUtc, input.utcOffsetSeconds));
      var jPast = jNow - histLen;
      if (jNow < 0 || jPast < 0 || histLen === 0) return;
      var lowSeries = s.forecast.hourly.cloud_cover_low;
      if (!lowSeries) return;
      var curLow = lowSeries[jNow], pastLow = lowSeries[jPast];
      if (!valid(curLow) || !valid(pastLow)) return;
      clearingValid++;
      var rate = pastLow - curLow;
      clearingRates.push(rate);
      if (s.point.distanceKm <= 100) nearRates.push(rate);
      else if (s.point.distanceKm >= 200) farRates.push(rate);
    });
    var clearingRate = clearingRates.length ? avg(clearingRates) : null;
    var nearClrRate = nearRates.length ? avg(nearRates) : null;
    var farClrRate = farRates.length ? avg(farRates) : null;

    /* 清空方向：远快于近 = 晴空从远方推进（方案 5.4 节） */
    var clearingDirection = 'none';
    if (clearingRate != null && clearingRate > 5) {
      if (farClrRate != null && nearClrRate != null) {
        if (farClrRate - nearClrRate > clrCfg.directionGap) clearingDirection = 'far_to_near';
        else if (nearClrRate - farClrRate > clrCfg.directionGap) clearingDirection = 'near_to_far';
        else clearingDirection = 'uniform';
      } else {
        clearingDirection = 'uniform';
      }
    }

    /* ClearingScore = 0.5×TimeReduction + 0.3×SpatialProgress + 0.2×CorridorOpening */
    var timeReduction = clamp(clearingRate != null ? clearingRate : 0, 0, 100);
    var spatialProgress = (farClrRate != null && nearClrRate != null)
      ? clamp(farClrRate - nearClrRate, 0, 100) : 0;
    var clearingScore = clrCfg.weights.time * timeReduction +
      clrCfg.weights.spatial * spatialProgress +
      clrCfg.weights.corridor * (corridorOpening != null ? corridorOpening : 50);
    var clearingConfidence = input.expectedSampleCount > 0
      ? Math.round(clearingValid / input.expectedSampleCount * 100) : 0;

    /* RAIN_TO_CLEAR_STRONG：V1.7 保留升级判定但不再直接加分，
       改为强度提升（方案 5.5 节 → V1.7 十一章） */
    var regimeStrong = regime === 'RAIN_TO_CLEAR' && clearingScore > clrCfg.strongThreshold;

    /* ===== V1.7 Regime Strength（技术方案 五~六 章） =====
       Regime 从布尔判定升级为连续强度（0-1），驱动动态权重插值；
       enabled=false 时 strength 保持中性值，动态权重不启用 */
    var v17 = cfg.weatherRegimeV17;
    var strength = 0.5;
    if (v17.enabled) {
      /* 低云趋势：正 = 低云正在增加（供 STORM 强度使用） */
      var lowCloudTrend = (sectorLowEarlier != null && sectorLowLater != null)
        ? sectorLowLater - sectorLowEarlier : 0;
      if (regime === 'CLEAR') {
        strength = valid(lv.cloud) ? clamp(1 - lv.cloud / 20, 0, 1) : 0.5;
      } else if (regime === 'OVERCAST') {
        strength = valid(lv.cloud) ? clamp((lv.cloud - 85) / 15, 0, 1) : 0.5;
      } else if (regime === 'PARTLY_CLOUDY') {
        /* 总云量越接近 50% 越典型 */
        strength = valid(lv.cloud) ? clamp(1 - Math.abs(lv.cloud - 50) / 60, 0.3, 1) : 0.5;
      } else if (regime === 'HAZY') {
        strength = 0.6 * (visKm != null ? clamp(1 - visKm / 5, 0, 1) : 0.5) +
          0.4 * (valid(lv.rh) ? clamp((lv.rh - 85) / 15, 0, 1) : 0.5);
      } else if (regime === 'RAIN_TO_CLEAR') {
        /* 方案 6.2 节：0.30 RainHistory + 0.30 ClearingFront
           + 0.20 OpeningTrend + 0.20 CloudStructure，输入均为 V1.61 已有能力 */
        var rsW = v17.rainToClearStrength;
        strength = rsW.history * clamp(pastRain / v17.rainHistoryFullMm, 0, 1) +
          rsW.clearingFront * (clearingScore / 100) +
          rsW.openingTrend * ((corridorOpening != null ? corridorOpening : 50) / 100) +
          rsW.cloudStructure * (cloudStructureScore / 100);
        if (regimeStrong) strength += v17.strongStrengthBoost;
      } else if (regime === 'FRONT_PASSING') {
        /* 方案 6.3 节：气压降幅 + 风速为基础，云梯度（云层逼近）增强 */
        strength = 0.5 * clamp(pressureDrop / 5, 0, 1) + 0.5 * clamp(wind / 60, 0, 1);
        if (gradientType === 'approaching_cloud') strength += 0.2;
      } else if (regime === 'STORM_APPROACHING') {
        /* 方案 6.4 节：Wind + Pressure Trend + Precipitation Increasing + Low Cloud Increasing */
        strength = 0.35 * clamp(wind / 80, 0, 1) +
          0.25 * clamp(pressureDrop / 8, 0, 1) +
          0.25 * clamp(curRain / 8, 0, 1) +
          0.15 * clamp(lowCloudTrend / 20, 0, 1);
      }
      strength = clamp(strength, 0, 1);
    }

    /* ===== V1.7 WeatherScore（技术方案十二章） =====
       WeatherScore = 0.4×CurrentCondition + 0.3×Trend + 0.3×Stability，
       替换 V1.61 的 regimeScore 静态查表 */
    var weatherBreakdown = null;
    if (v17.enabled) {
      var wsCfg = v17.weatherScore;
      /* CurrentCondition：regime 基线分，按当前降水/降水概率折减 */
      var currentCondition = clamp(cfg.regimeScore[regime] -
        10 * clamp(curRain / 4, 0, 1) - 15 * (rainProb / 100), 0, 100);
      /* Trend：清空锋面 + 空间梯度（负梯度 = 云层逼近 → 低分） */
      var gradientTrend = clamp(50 + (gradientVal != null ? gradientVal : 0) * 0.5, 0, 100);
      var trendScore = 0.6 * clearingScore + 0.4 * gradientTrend;
      /* Stability：日落前 stabilityHours 小时云量/降水/风速的恶化程度 */
      var hourlyLocal = localSample.forecast.hourly;
      var stabStart = Math.max(0, idx - wsCfg.stabilityHours);
      function seriesDelta(key) {
        var s = hourlyLocal[key];
        if (!s || !valid(s[idx]) || !valid(s[stabStart])) return 0;
        return s[idx] - s[stabStart];
      }
      var deterioration = Math.max(0, seriesDelta('cloud_cover')) * 0.8 +
        Math.max(0, seriesDelta('precipitation')) * 15 +
        Math.max(0, seriesDelta('wind_speed_10m')) * 1.0;
      var stability = clamp(100 - deterioration, 0, 100);
      weather = wsCfg.current * currentCondition +
        wsCfg.trend * trendScore + wsCfg.stability * stability;
      weatherBreakdown = {
        current: Math.round(currentCondition),
        trend: Math.round(trendScore),
        stability: Math.round(stability)
      };
    }

    /* ===== V1.7 Dynamic Weight Controller（技术方案 七~九 章） =====
       FinalWeight = BaseWeight × (1 + (RegimeMult − 1) × strength)：
       按 strength 在基础权重与 regime 乘数间插值（strength=0 退化为 V1.61 权重），
       Weather 权重施加下限后整体归一 Σ=1 */
    var dynamicWeights = null;
    if (v17.enabled) {
      var mults = v17.weights[regime] ||
        { skyCanvas: 1, horizon: 1, illumination: 1, atmosphere: 1, weather: 1 };
      function blendWeight(base, mult) { return base * (1 + (mult - 1) * strength); }
      dynamicWeights = {
        skyCanvas: blendWeight(cfg.weights.skyCanvas, mults.skyCanvas),
        horizon: blendWeight(cfg.weights.horizon, mults.horizon),
        illumination: blendWeight(cfg.weights.illumination, mults.illumination),
        atmosphere: blendWeight(cfg.weights.atmosphere, mults.atmosphere),
        weather: Math.max(blendWeight(cfg.weights.weather, mults.weather), v17.minimumWeatherWeight)
      };
      var wSum = dynamicWeights.skyCanvas + dynamicWeights.horizon +
        dynamicWeights.illumination + dynamicWeights.atmosphere + dynamicWeights.weather;
      Object.keys(dynamicWeights).forEach(function (k) { dynamicWeights[k] /= wSum; });
    }

    /* ===== V1.7 Regime Transition（技术方案十章） =====
       在日落前后各取一个对比时刻估计简化天气型，按"晴朗进度"排序
       判定 IMPROVING / DETERIORATING / STABLE，映射受限的过渡加分 */
    var transition = 'STABLE', transitionScore = 50, transitionBonusVal = 0;
    if (v17.enabled && v17.transitionEnabled) {
      var progressRank = {
        STORM_APPROACHING: 0, FRONT_PASSING: 1, OVERCAST: 2, HAZY: 2,
        RAIN_TO_CLEAR: 3, PARTLY_CLOUDY: 4, CLEAR: 5
      };
      function simpleRegimeAt(i) {
        var h = localSample.forecast.hourly;
        function atH(key) { return h[key] ? h[key][i] : null; }
        var c = atH('cloud_cover'), pr = atH('precipitation');
        var pb = atH('precipitation_probability'), wd = atH('wind_speed_10m');
        var prV = valid(pr) ? pr : 0, pbV = valid(pb) ? pb : 0, wdV = valid(wd) ? wd : 0;
        if (wdV >= 60 || (pbV >= 80 && prV >= 8)) return 'STORM_APPROACHING';
        if (prV >= cfg.rainToClearMinRainMm || pbV >= 70) return 'FRONT_PASSING';
        if (valid(c) && c >= 85) return 'OVERCAST';
        if (valid(c) && c < 20) return 'CLEAR';
        return 'PARTLY_CLOUDY';
      }
      var pastIdx = idx - v17.transitionLookbackHours;
      var futureIdx = idx + v17.transitionLeadHours;
      if (pastIdx >= 0 && futureIdx < times.length) {
        var progressDelta = progressRank[simpleRegimeAt(futureIdx)] -
          progressRank[simpleRegimeAt(pastIdx)];
        if (progressDelta >= 1) transition = 'IMPROVING';
        else if (progressDelta <= -1) transition = 'DETERIORATING';
        transitionScore = clamp(50 + progressDelta * 10, 0, 100);
        transitionBonusVal = clamp(progressDelta * v17.transitionBonusPerStep,
          -v17.transitionBonusLimit, v17.transitionBonusLimit);
      }
    }

    /* ===== 16. Weather Penalty ===== */
    var pWeather = 0;
    if (regime === 'STORM_APPROACHING') {
      var stormScale = clamp(wind / 80, 0, 1);
      pWeather += cfg.penalty.storm[0] + (cfg.penalty.storm[1] - cfg.penalty.storm[0]) * stormScale;
    } else if (curRain >= 0.5 || rainProb >= 70) {
      var rainScale = clamp(0.5 * rainProb / 100 + 0.5 * clamp(curRain, 0, 4) / 4, 0, 1);
      pWeather += cfg.penalty.rain[0] + (cfg.penalty.rain[1] - cfg.penalty.rain[0]) * rainScale;
    }
    if (visKm != null && visKm < 10) {
      pWeather += clamp(5 + (10 - visKm) * 1.5, cfg.penalty.haze[0], cfg.penalty.haze[1]);
    }

    /* ===== 17. Hard Gate ===== */
    var hardGates = [];
    if (horizon < cfg.hardGate.horizonOpeningPct) hardGates.push('地平线严重遮挡（开阔度不足 10%）');
    if (visKm != null && visKm < cfg.hardGate.visibilityKm) hardGates.push('能见度极低（不足 2 km）');
    if (rainProb >= 80 && curRain >= 4) hardGates.push('日落期间持续强降水');
    if (regime === 'STORM_APPROACHING') hardGates.push('强天气系统正在逼近');

    /* ===== 18. 最终公式（V1.7：天气型动态权重） ===== */
    var P, bonus;
    if (v17.enabled) {
      P = dynamicWeights.skyCanvas * skyCanvas +
        dynamicWeights.horizon * horizon +
        dynamicWeights.illumination * illumination +
        dynamicWeights.atmosphere * atmosphere +
        dynamicWeights.weather * weather;
      /* 加分拆解：空间结构加分 + regime 过渡加分（天气型直接加分已移除） */
      bonus = structureBonus + transitionBonusVal;
    } else {
      /* A/B 回退：V1.61 原公式 */
      P = cfg.weights.skyCanvas * skyCanvas +
        cfg.weights.horizon * horizon +
        cfg.weights.illumination * illumination +
        cfg.weights.atmosphere * atmosphere +
        cfg.weights.weather * weather;
      var regimeBonusVal = cfg.regimeBonus[regime] || 0;
      var legacyClearingBonus = regimeStrong ? clrCfg.strongBonus : 0;
      bonus = regimeBonusVal + structureBonus + legacyClearingBonus;
    }
    var Q = cfg.atmosphereQuality.base + cfg.atmosphereQuality.scale * (atmosphere / 100);
    var score = clamp(P * Q * gate + bonus - pWeather, 0, 100);
    if (hardGates.length) score = Math.min(score, cfg.hardGate.scoreCap);
    score = Math.round(score);

    /* ===== 19. 等级 ===== */
    var level = cfg.levels[cfg.levels.length - 1].label;
    for (var li = 0; li < cfg.levels.length; li++) {
      if (score >= cfg.levels[li].min) { level = cfg.levels[li].label; break; }
    }

    /* ===== 20. Confidence ===== */
    var available = [ls.high, ls.mid, ls.lowGood, visKm, aod, pm25];
    var present = available.filter(function (v) { return v != null; }).length;
    var completeness = present / available.length * 100;

    var fetched = input.samples.filter(function (s) { return !!s.forecast; }).length;
    /* V1.8：优先使用加权完整度（核心节点权重高），未传入时回退简单比例 */
    var spatial = input.spatialCompleteness != null
      ? input.spatialCompleteness * 100
      : fetched / input.expectedSampleCount * 100;

    var lowArr = input.samples.map(function (s) { return valueAt(s, 'low'); }).filter(valid);
    var spatialVariance = (input.cloudField && input.cloudField.summary && input.cloudField.summary.spatialVariance != null)
      ? input.cloudField.summary.spatialVariance
      : stdDev(lowArr);
    var consistency = clamp(100 - spatialVariance * 1.5, 0, 100);

    var hoursToSunset = (input.solar.sunset.valueOf() - input.localNowUtc.valueOf()) / 3600000;
    var proximity = hoursToSunset < 0 ? 60 : (hoursToSunset <= 24 ? 100 : clamp(100 - (hoursToSunset - 24) * 5, 0, 100));
    var freshness = 90; /* 小时级预报默认为新鲜数据 */
    /* V1.8：STALE 缓存回退数据的新鲜度衰减（仅影响 confidence，不影响 score） */
    if (input.cacheStatus === 'STALE' && valid(input.dataAgeMinutes)) {
      freshness = clamp(90 - Math.max(0, input.dataAgeMinutes - cfg.cacheTtlMinutes) / 60 * 10, 30, 90);
    }

    var confidence = Math.round(
      0.30 * completeness + 0.15 * freshness + 0.20 * spatial + 0.20 * consistency + 0.15 * proximity
    );

    /* ===== 原因与风险提示 ===== */
    var reasons = [], warnings = [];
    if (horizon >= 70) reasons.push('日落方向低云较少，地平线比较开阔');
    else if (horizon < 40) warnings.push('日落方向低云较多，地平线不够开阔');
    /* V1.6 空间语义解释（方案十章） */
    if (corridorOpening != null && corridorOpening >= 80) reasons.push('日落核心方向无遮挡');
    if (bankScore >= 70) reasons.push('太阳附近形成云幕结构');
    if (contrastRaw != null && contrastRaw >= 30) reasons.push('云幕集中度好，中心云量显著高于两侧');
    /* V1.61 空间演化解释（增强方案十章） */
    if (continuity >= 85) reasons.push('远方云幕连续');
    if (gradientVal != null && gradientVal > sf61.structure.bonusGradientMin) reasons.push('云层正在向远方集中');
    if (gradientType === 'approaching_cloud') warnings.push('云层正在逼近，日落前景可能转差');
    if (clearingDirection === 'far_to_near' && clearingRate != null && clearingRate >= 20) reasons.push('晴空正在从日落方向推进');
    if (regimeStrong) reasons.push('天空打开速度快，雨后晚霞潜力增强');
    /* V1.7 天气型动态权重解释 */
    if (v17.enabled && strength >= 0.7) reasons.push('天气型信号明确（' +
      (cfg.regimeLabels[regime] || regime) + ' 强度 ' + Math.round(strength * 100) + '%）');
    if (v17.enabled && transition === 'IMPROVING') reasons.push('天气型正在向有利方向过渡（过渡评分 ' + transitionScore + '）');
    if (v17.enabled && transition === 'DETERIORATING') warnings.push('天气型正在转差，日落时段天空条件可能恶化');
    if (sf61.antiSunset.enabled && antiSunsetScore >= 60) reasons.push('反太阳方向存在高云背景');
    if (ls.high != null && ls.high >= 70) reasons.push('中高云条件适合形成云幕');
    else if (ls.high != null && ls.high < 30) warnings.push('缺少足够的中高云作为云幕');
    if (regime === 'RAIN_TO_CLEAR') reasons.push('降雨在日落前黄金窗口内结束，日落方向低云正在减少');
    if (visKm != null && visKm >= 15) reasons.push('大气能见度较好');
    if (valid(aod) && aod > 0.5) warnings.push('气溶胶偏多，可能影响夕阳色彩');
    if (valid(pm25) && pm25 > 50) warnings.push('大气透明度一般（PM2.5 偏高）');
    if (rainProb >= 50) warnings.push('日落时段存在降水风险（概率 ' + Math.round(rainProb) + '%）');
    hardGates.forEach(function (g) { warnings.push('硬限制：' + g); });
    if (!reasons.length) reasons.push('整体条件一般，可留意临近时段的变化');

    /* ===== 结果对象（第 27 章格式） ===== */
    return {
      city: input.location.name,
      country: input.location.country,
      latitude: input.location.latitude,
      longitude: input.location.longitude,

      sunset_utc: input.solar.sunset.toISOString(),
      sunset_azimuth: Math.round(input.solar.sunsetAzimuthDeg),

      score: score,
      confidence: confidence,
      level: level,

      /* V1.8 数据层元信息（方案 9、15、17 章），仅供展示与升级决策 */
      sampling_mode: input.samplingMode || 'FULL',
      spatial_completeness: input.spatialCompleteness != null
        ? Math.round(input.spatialCompleteness * 100) / 100
        : (input.expectedSampleCount > 0 ? Math.round(fetched / input.expectedSampleCount * 100) / 100 : null),
      spatial_variance: Math.round(spatialVariance * 10) / 10,
      data_freshness: Math.round(freshness),
      cache_status: input.cacheStatus || 'MISS',
      escalated: !!input.escalated,
      escalation_reason: input.escalationReason || null,
      data_age: valid(input.dataAgeMinutes) ? input.dataAgeMinutes : 0,

      /* V1.9 Nowcasting 元信息透传（修正量由 app.js 叠加，引擎不感知） */
      nowcast: input.nowcast || null,

      /* V2.0 天空演化元信息透传（概率因子由 app.js 叠加，引擎不感知） */
      sky_evolution: input.skyEvolution || null,

      components: {
        sky_canvas: Math.round(skyCanvas),
        horizon: Math.round(horizon),
        illumination: Math.round(illumination),
        atmosphere: Math.round(atmosphere),
        weather: Math.round(weather)
      },

      regime: regime,
      regime_label: (cfg.regimeLabels[regime] || regime) + (regimeStrong ? '（强）' : ''),
      bonus: bonus,
      transition_bonus: transitionBonusVal,
      penalty: Math.round(pWeather),
      horizon_gate: gate,
      hard_gates: hardGates,

      /* V1.6/V2.1 空间语义输出（方案六章与 360° 反日落） */
      cloud_structure: {
        bankScore: Math.round(bankScore),
        centerCloud: centerCloudRaw != null ? Math.round(centerCloudRaw) : null,
        contrast: contrastRaw != null ? Math.round(contrastRaw) : null,
        continuity: Math.round(continuity),
        structureScore: Math.round(cloudStructureScore),
        antiSunsetScore: Math.round(antiSunsetScore),
        antiSunsetCloud: antiHighVal,
        antiSunsetTotal: antiTotalVal
      },
      /* V1.61 空间演化输出（增强方案七章） */
      spatial_gradient: {
        value: gradientVal != null ? Math.round(gradientVal) : null,
        type: gradientType
      },
      /* V1.61 清空锋面输出（方案 5.4 节） */
      clearing_front: {
        rate: clearingRate != null ? Math.round(clearingRate) : null,
        direction: clearingDirection,
        confidence: clearingConfidence,
        score: Math.round(clearingScore)
      },
      structure_bonus: structureBonus,
      sector_openings: {
        corridor: corridorOpening != null ? Math.round(corridorOpening) : null,
        bank: bankOpening != null ? Math.round(bankOpening) : null,
        side: sideOpening != null ? Math.round(sideOpening) : null
      },
      distance_confidence: Math.round(distanceConfidence * 100) / 100,

      /* V1.7 天气型状态输出（技术方案十三章） */
      regime_state: v17.enabled ? {
        type: regime,
        strength: Math.round(strength * 100) / 100,
        transition: transition,
        transitionScore: transitionScore,
        dynamicWeight: {
          skyCanvas: Math.round(dynamicWeights.skyCanvas * 100) / 100,
          horizon: Math.round(dynamicWeights.horizon * 100) / 100,
          illumination: Math.round(dynamicWeights.illumination * 100) / 100,
          atmosphere: Math.round(dynamicWeights.atmosphere * 100) / 100,
          weather: Math.round(dynamicWeights.weather * 100) / 100
        }
      } : null,
      weather_score: weatherBreakdown,

      reasons: reasons,
      warnings: warnings,

      data: {
        visibility_km: visKm != null ? Math.round(visKm * 10) / 10 : null,
        aod: valid(aod) ? Math.round(aod * 100) / 100 : null,
        pm25: valid(pm25) ? Math.round(pm25) : null,
        humidity: valid(lv.rh) ? Math.round(lv.rh) : null,
        cloud_cover: valid(lv.cloud) ? Math.round(lv.cloud) : null,
        cloud_low: valid(lv.low) ? Math.round(lv.low) : null,
        cloud_mid: valid(lv.mid) ? Math.round(lv.mid) : null,
        cloud_high: valid(lv.high) ? Math.round(lv.high) : null,
        samples_fetched: input.totalSkyNodeCount || fetched,
        samples_expected: input.totalSkyNodeCount || input.expectedSampleCount,
        twilight_minutes: Math.round(input.solar.twilightMinutes)
      },

      model_version: cfg.version
    };
  }

  SS.engine = {
    compute: compute,
    hourIndex: hourIndex,
    /* 供 app.js 生成最佳观赏时间 */
    bestViewing: function (solar, cfg) {
      var w = cfg.viewingWindow;
      return {
        startUtc: new Date(solar.sunset.valueOf() + w.startOffsetMin * 60000),
        peakUtc: new Date(solar.sunset.valueOf() + w.peakOffsetMin * 60000),
        endUtc: new Date(solar.civilDusk.valueOf() + w.endAfterCivilDuskMin * 60000)
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
