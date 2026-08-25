/* ============================================================
 * SunsetScore V2.1 - 风场驱动云平流运动与未来状态预测引擎 (Cloud Motion Engine)
 * 实现 Advection 平流逆风采样、上游浓云追踪与 CloudArrivalRisk 评估。
 * 预测未来 30 / 60 / 120 分钟全天空云场状态。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var rad = Math.PI / 180;

  /**
   * 在当前云场网格中根据极坐标 (distKm, azDeg) 双线性/角度插值估算云量
   */
  function interpolateCloudAt(cloudField, distKm, azDeg) {
    if (!cloudField || !cloudField.nodes) {
      return { cloud_cover: 0, cloud_cover_low: 0, cloud_cover_mid: 0, cloud_cover_high: 0 };
    }

    /* 限制在 0~300km */
    var d = Math.max(0, Math.min(300, distKm));
    if (d === 0) {
      var cData = (cloudField.center && cloudField.center.data) || {};
      return {
        cloud_cover: cData.cloud_cover || 0,
        cloud_cover_low: cData.cloud_cover_low || 0,
        cloud_cover_mid: cData.cloud_cover_mid || 0,
        cloud_cover_high: cData.cloud_cover_high || 0
      };
    }

    var az = ((azDeg % 360) + 360) % 360;
    var dirs = SS.cloudField.DIRECTIONS;
    var azs = SS.cloudField.AZIMUTHS;
    var dists = SS.cloudField.DISTANCES_KM;

    /* 寻找方位角相邻的两个方向射线 */
    var dirIdx1 = 0, dirIdx2 = 1;
    var fracAz = 0;
    for (var i = 0; i < azs.length; i++) {
      var a1 = azs[i];
      var a2 = (i === azs.length - 1) ? 360 : azs[i + 1];
      if (az >= a1 && az <= a2) {
        dirIdx1 = i;
        dirIdx2 = (i === azs.length - 1) ? 0 : i + 1;
        fracAz = (az - a1) / (a2 - a1);
        break;
      }
    }

    /* 寻找距离相邻的两档 */
    var dIdx1 = 0, dIdx2 = 0;
    var fracD = 0;
    if (d <= dists[0]) {
      /* 中心到第一档 (0 ~ 50km) */
      fracD = d / dists[0];
      var cD = (cloudField.center && cloudField.center.data) || {};
      var n1 = cloudField.nodeMap[dirs[dirIdx1] + '_' + dists[0]];
      var n2 = cloudField.nodeMap[dirs[dirIdx2] + '_' + dists[0]];
      var d1 = n1 ? n1.data : cD;
      var d2 = n2 ? n2.data : cD;

      function blendCenter(k) {
        var ringVal = (d1[k] || 0) * (1 - fracAz) + (d2[k] || 0) * fracAz;
        return Math.round((cD[k] || 0) * (1 - fracD) + ringVal * fracD);
      }

      return {
        cloud_cover: blendCenter('cloud_cover'),
        cloud_cover_low: blendCenter('cloud_cover_low'),
        cloud_cover_mid: blendCenter('cloud_cover_mid'),
        cloud_cover_high: blendCenter('cloud_cover_high')
      };
    }

    for (var j = 0; j < dists.length - 1; j++) {
      if (d >= dists[j] && d <= dists[j + 1]) {
        dIdx1 = j;
        dIdx2 = j + 1;
        fracD = (d - dists[j]) / (dists[j + 1] - dists[j]);
        break;
      }
    }
    if (d > dists[dists.length - 1]) {
      dIdx1 = dists.length - 1;
      dIdx2 = dists.length - 1;
      fracD = 1;
    }

    var node11 = cloudField.nodeMap[dirs[dirIdx1] + '_' + dists[dIdx1]];
    var node12 = cloudField.nodeMap[dirs[dirIdx1] + '_' + dists[dIdx2]];
    var node21 = cloudField.nodeMap[dirs[dirIdx2] + '_' + dists[dIdx1]];
    var node22 = cloudField.nodeMap[dirs[dirIdx2] + '_' + dists[dIdx2]];

    function getV(n, k) { return (n && n.data && n.data[k] != null) ? n.data[k] : 0; }

    function bilinear(k) {
      var v11 = getV(node11, k);
      var v12 = getV(node12, k);
      var v21 = getV(node21, k);
      var v22 = getV(node22, k);

      var v1 = v11 * (1 - fracD) + v12 * fracD;
      var v2 = v21 * (1 - fracD) + v22 * fracD;
      return Math.round(v1 * (1 - fracAz) + v2 * fracAz);
    }

    return {
      cloud_cover: bilinear('cloud_cover'),
      cloud_cover_low: bilinear('cloud_cover_low'),
      cloud_cover_mid: bilinear('cloud_cover_mid'),
      cloud_cover_high: bilinear('cloud_cover_high')
    };
  }

  /**
   * 预测未来 deltaMinutes (30/60/120) 时刻的全天空云场
   * 若提供原始采样样本 skySamples，则优先采用 NWP 模型自身更高精度的时序插值预报；
   * 若无原始样本（单快照回退），则采用分层动力学切变平流位移进行外推。
   */
  function predictFutureField(cloudField, windSpeedKmH, windFromDeg, deltaMinutes, skySamples, baseTimeUtc) {
    if (skySamples && Array.isArray(skySamples) && skySamples.length) {
      var baseMs = (baseTimeUtc instanceof Date)
        ? baseTimeUtc.getTime()
        : (typeof baseTimeUtc === 'number' ? baseTimeUtc : (cloudField ? cloudField.timestamp : Date.now()));
      var targetDate = new Date(baseMs + deltaMinutes * 60000);
      var futureField = SS.cloudField.buildCloudField(skySamples, targetDate);
      futureField.minutesAhead = deltaMinutes;
      return futureField;
    }

    var centerLat = (cloudField.center && cloudField.center.latitude) || 30;
    var futureNodes = [];
    var totalSum = 0, lowSum = 0, midSum = 0, highSum = 0;

    cloudField.nodes.forEach(function (n) {
      /* 当前节点极坐标与局部笛卡尔坐标 */
      var radAz = n.azimuth * rad;
      var currX = n.distanceKm * Math.sin(radAz);
      var currY = n.distanceKm * Math.cos(radAz);
      var nodeLat = n.latitude != null ? n.latitude : centerLat;

      /* 分布式节点风场：结合节点局部观测、高空等压面风与中心风 */
      var nData = n.data || {};
      var localSpeed = (nData.wind_speed_10m != null) ? nData.wind_speed_10m : windSpeedKmH;
      var localDir = (nData.wind_direction_10m != null) ? nData.wind_direction_10m : windFromDeg;

      /* 1. 低云分层平流采样 (LOW - 850hPa) */
      var offLow = SS.wind.calculateLayerAdvectionOffset(localSpeed, localDir, 'LOW', deltaMinutes, nodeLat, nData);
      var upXLow = currX + offLow.upstreamDx;
      var upYLow = currY + offLow.upstreamDy;
      var upDistLow = Math.sqrt(upXLow * upXLow + upYLow * upYLow);
      var upAzLow = ((Math.atan2(upXLow, upYLow) / rad) + 360) % 360;
      var sampleLow = interpolateCloudAt(cloudField, upDistLow, upAzLow);
      var predLow = sampleLow.cloud_cover_low;

      /* 2. 中云分层平流采样 (MID - 700hPa) */
      var offMid = SS.wind.calculateLayerAdvectionOffset(localSpeed, localDir, 'MID', deltaMinutes, nodeLat, nData);
      var upXMid = currX + offMid.upstreamDx;
      var upYMid = currY + offMid.upstreamDy;
      var upDistMid = Math.sqrt(upXMid * upXMid + upYMid * upYMid);
      var upAzMid = ((Math.atan2(upXMid, upYMid) / rad) + 360) % 360;
      var sampleMid = interpolateCloudAt(cloudField, upDistMid, upAzMid);
      var predMid = sampleMid.cloud_cover_mid;

      /* 3. 高云分层平流采样 (HIGH - 500hPa) */
      var offHigh = SS.wind.calculateLayerAdvectionOffset(localSpeed, localDir, 'HIGH', deltaMinutes, nodeLat, nData);
      var upXHigh = currX + offHigh.upstreamDx;
      var upYHigh = currY + offHigh.upstreamDy;
      var upDistHigh = Math.sqrt(upXHigh * upXHigh + upYHigh * upYHigh);
      var upAzHigh = ((Math.atan2(upXHigh, upYHigh) / rad) + 360) % 360;
      var sampleHigh = interpolateCloudAt(cloudField, upDistHigh, upAzHigh);
      var predHigh = sampleHigh.cloud_cover_high;

      /* 4. 最大-随机物理重叠法则（Maximum-Random Overlap）合成总云量 */
      var cl = predLow / 100, cm = predMid / 100, ch = predHigh / 100;
      var totalCover = Math.round(100 * (1 - (1 - cl) * (1 - cm) * (1 - ch)));
      totalCover = Math.max(totalCover, Math.max(predLow, Math.max(predMid, predHigh)));

      var nodePred = {
        cloud_cover: totalCover,
        cloud_cover_low: predLow,
        cloud_cover_mid: predMid,
        cloud_cover_high: predHigh
      };

      futureNodes.push({
        key: n.key,
        direction: n.direction,
        azimuth: n.azimuth,
        distanceKm: n.distanceKm,
        latitude: n.latitude,
        longitude: n.longitude,
        data: nodePred
      });

      totalSum += totalCover;
      lowSum += predLow;
      midSum += predMid;
      highSum += predHigh;
    });

    /* 中心点分层未来云量预测 */
    var cData = (cloudField.center && cloudField.center.data) || {};
    var cOffLow = SS.wind.calculateLayerAdvectionOffset(windSpeedKmH, windFromDeg, 'LOW', deltaMinutes, centerLat, cData);
    var cOffMid = SS.wind.calculateLayerAdvectionOffset(windSpeedKmH, windFromDeg, 'MID', deltaMinutes, centerLat, cData);
    var cOffHigh = SS.wind.calculateLayerAdvectionOffset(windSpeedKmH, windFromDeg, 'HIGH', deltaMinutes, centerLat, cData);

    var cLow = interpolateCloudAt(cloudField, cOffLow.distanceKm, cOffLow.upstreamHeadingDeg).cloud_cover_low;
    var cMid = interpolateCloudAt(cloudField, cOffMid.distanceKm, cOffMid.upstreamHeadingDeg).cloud_cover_mid;
    var cHigh = interpolateCloudAt(cloudField, cOffHigh.distanceKm, cOffHigh.upstreamHeadingDeg).cloud_cover_high;
    var cCl = cLow / 100, cCm = cMid / 100, cCh = cHigh / 100;
    var cTotal = Math.round(100 * (1 - (1 - cCl) * (1 - cCm) * (1 - cCh)));
    cTotal = Math.max(cTotal, Math.max(cLow, Math.max(cMid, cHigh)));

    var count = futureNodes.length || 1;
    return {
      minutesAhead: deltaMinutes,
      center: {
        data: {
          cloud_cover: cTotal,
          cloud_cover_low: cLow,
          cloud_cover_mid: cMid,
          cloud_cover_high: cHigh
        }
      },
      nodes: futureNodes,
      avgCloudCover: Math.round(totalSum / count),
      avgCloudLow: Math.round(lowSum / count),
      avgCloudMid: Math.round(midSum / count),
      avgCloudHigh: Math.round(highSum / count)
    };
  }

  /**
   * 评估上游浓云进入指定方位（如日落走廊）的到达时间与遮挡风险（分层动力学）
   */
  function evaluateArrivalRisk(cloudField, targetAzimuthDeg, windSpeedKmH, windFromDeg, upperWindData) {
    var centerLat = (cloudField.center && cloudField.center.latitude) || 30;
    var cData = upperWindData || (cloudField.center && cloudField.center.data) || {};
    var cfg = (SS.config && SS.config.windMotionV21 && SS.config.windMotionV21.arrivalRisk) || {};
    var denseThreshold = cfg.denseCloudCoverMin || 65;
    var maxHorizonMin = cfg.maxArrivalHorizonMin || 180; /* 日落演化有效时效上限（180 分钟） */

    /* 低云与中云层分层风向风速（优先使用 850hPa/700hPa 真实等压面风） */
    var lowWind = SS.wind.getLayerWind(windSpeedKmH, windFromDeg, 'LOW', centerLat, cData);
    var midWind = SS.wind.getLayerWind(windSpeedKmH, windFromDeg, 'MID', centerLat, cData);

    /* 寻找沿低云风向吹向目标走廊的上游区域 */
    var upstreamNodes = cloudField.getCorridorSlice(lowWind.fromDeg, cfg.upstreamSectorHalfWidthDeg || 35);

    var highestDenseCover = 0;
    var closestDenseDistKm = null;

    upstreamNodes.forEach(function (n) {
      if (n.distanceKm > 0) {
        var d = n.data || {};
        /* 整数规整与 [0, 100] 限幅，杜绝浮点精度溢出 */
        var rawCover = Math.max(d.cloud_cover || 0, d.cloud_cover_low || 0, (d.cloud_cover_mid || 0) * 0.95);
        var maxCloud = Math.min(100, Math.round(rawCover));
        if (maxCloud >= denseThreshold) {
          if (maxCloud > highestDenseCover) highestDenseCover = maxCloud;
          if (closestDenseDistKm === null || n.distanceKm < closestDenseDistKm) {
            closestDenseDistKm = n.distanceKm;
          }
        }
      }
    });

    /* 到达时间由低云分层特征物理流速推算 */
    var effSpeed = Math.max(8, lowWind.speedKmH);
    var rawArrivalMin = closestDenseDistKm != null
      ? Math.round((closestDenseDistKm / effSpeed) * 60)
      : null;

    /* 门控判定：到达时间超过日落演化时效上限（如 >180分钟），视为对本日落无即时威胁 */
    var isWithinHorizon = rawArrivalMin != null && rawArrivalMin <= maxHorizonMin;
    var arrivalMinutes = isWithinHorizon ? rawArrivalMin : null;

    /* 计算 30 / 60 / 120 分钟的到达风险概率 (0.0 ~ 1.0) */
    function calcRisk(tHorizonMin) {
      if (!isWithinHorizon || closestDenseDistKm === null || highestDenseCover < denseThreshold) {
        return 0.02;
      }
      var timeDiff = Math.abs((arrivalMinutes || 999) - tHorizonMin);
      var timeFactor = Math.exp(-timeDiff / 35);
      var densityFactor = (highestDenseCover - 40) / 60;
      var risk = densityFactor * timeFactor;
      return Math.max(0.02, Math.min(0.95, Number(risk.toFixed(2))));
    }

    var summaryText = '上游无显著浓云威胁（日落窗口内通畅）';
    if (isWithinHorizon && closestDenseDistKm != null) {
      if (arrivalMinutes <= 60) {
        summaryText = '上游 ' + closestDenseDistKm + 'km 处存在密云(' + highestDenseCover + '%)，预计 ' + arrivalMinutes + ' 分钟后进入走廊';
      } else {
        var hoursStr = (arrivalMinutes / 60).toFixed(1);
        summaryText = '上游 ' + closestDenseDistKm + 'km 处存在密云(' + highestDenseCover + '%)，预计 ' + hoursStr + ' 小时后进入走廊';
      }
    }

    return {
      hasUpstreamDenseCloud: isWithinHorizon,
      upstreamCloudCover: highestDenseCover,
      upstreamDistanceKm: isWithinHorizon ? closestDenseDistKm : null,
      estimatedArrivalMin: arrivalMinutes,
      effectiveSpeedKmH: effSpeed,
      windSpeedKmH: windSpeedKmH,
      windFromDeg: windFromDeg,
      lowLayerWind: lowWind,
      midLayerWind: midWind,
      risk30m: calcRisk(30),
      risk60m: calcRisk(60),
      risk120m: calcRisk(120),
      summaryText: summaryText
    };
  }

  /**
   * 运行完整的未来云场平流预测流水线 (30 / 60 / 120 分钟)
   */
  function forecast(cloudField, targetAzimuthDeg, skySamples, nowUtc) {
    var cData = (cloudField.center && cloudField.center.data) || {};
    var centerLat = (cloudField.center && cloudField.center.latitude) || 30;
    var windSpd = (cData.wind_speed_10m != null) ? cData.wind_speed_10m : 15;
    var windGust = (cData.wind_gusts_10m != null) ? cData.wind_gusts_10m : null;
    var windDir = (cData.wind_direction_10m != null) ? cData.wind_direction_10m : 270;

    /* 分层动力学风场（优先接入 850/700/500hPa 真实等压面风） */
    var lowWind = SS.wind.getLayerWind(windSpd, windDir, 'LOW', centerLat, cData);
    var midWind = SS.wind.getLayerWind(windSpd, windDir, 'MID', centerLat, cData);
    var highWind = SS.wind.getLayerWind(windSpd, windDir, 'HIGH', centerLat, cData);

    var f30 = predictFutureField(cloudField, windSpd, windDir, 30, skySamples, nowUtc);
    var f60 = predictFutureField(cloudField, windSpd, windDir, 60, skySamples, nowUtc);
    var f120 = predictFutureField(cloudField, windSpd, windDir, 120, skySamples, nowUtc);

    var arrivalRisk = evaluateArrivalRisk(cloudField, targetAzimuthDeg, windSpd, windDir, cData);
    var dirInfo = SS.wind.formatDirection(windDir);
    var beaufortInfo = SS.wind.formatBeaufort ? SS.wind.formatBeaufort(windSpd) : { level: 1, name: '软风' };

    return {
      currentTimestamp: cloudField.timestamp,
      /* 地面体感风（供界面展示） */
      wind: {
        speedKmH: windSpd,
        gustsKmH: windGust,
        directionDeg: windDir,
        label: dirInfo.label,
        beaufort: beaufortInfo
      },
      /* 分层云移动风动力学数据（供推演与专业面板分析） */
      layerWinds: {
        low: lowWind,
        mid: midWind,
        high: highWind
      },
      arrivalRisk: arrivalRisk,
      predictions: {
        m30: f30,
        m60: f60,
        m120: f120
      }
    };
  }

  SS.cloudMotion = {
    interpolateCloudAt: interpolateCloudAt,
    predictFutureField: predictFutureField,
    evaluateArrivalRisk: evaluateArrivalRisk,
    forecast: forecast
  };
})(typeof window !== 'undefined' ? window : globalThis);
