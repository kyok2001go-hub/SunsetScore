/* ============================================================
 * SunsetScore V2.1 - 全天空 360° 云场模型 (Cloud Field Engine)
 * 8 方位 (N, NE, E, SE, S, SW, W, NW) × 4 距离 (50, 100, 200, 300km)
 * × 3 云层 (LOW, MID, HIGH) = 96 空间状态网格。
 * 配合 Multi-Coordinate Batch 实现单次请求全天空场构建。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  var AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315];
  var DISTANCES_KM = [50, 100, 200, 300];

  /**
   * 生成全天空 33 节点空间采样网格（1 中心点 + 8 方向 × 4 距离）
   */
  function generateGridNodes(lat, lon) {
    var cfg = (SS.config && SS.config.cloudFieldV21) || {};
    var dirs = cfg.directions || DIRECTIONS;
    var azs = cfg.azimuths || AZIMUTHS;
    var dists = cfg.distancesKm || DISTANCES_KM;

    var nodes = [];
    /* 0. 中心本地节点 */
    nodes.push({
      key: 'CENTER_0',
      direction: 'CENTER',
      azimuth: 0,
      distanceKm: 0,
      latitude: lat,
      longitude: lon,
      weight: 1.0
    });

    /* 1. 8 方位 × 4 距离 = 32 个远端节点 */
    dirs.forEach(function (dir, dirIdx) {
      var az = azs[dirIdx];
      dists.forEach(function (dist) {
        var p = SS.data.destinationPoint(lat, lon, az, dist);
        nodes.push({
          key: dir + '_' + dist,
          direction: dir,
          azimuth: az,
          distanceKm: dist,
          latitude: p.latitude,
          longitude: p.longitude,
          weight: dist <= 100 ? 0.9 : 0.6
        });
      });
    });

    return nodes;
  }

  /**
   * 从预报时序中高精度插值提取时刻数据（支持连续时间线性插值与最近邻保护）
   */
  function extractInterpolatedAt(forecast, timeUtc) {
    if (!forecast || !forecast.hourly || !forecast.hourly.time || !forecast.hourly.time.length) {
      return null;
    }
    var h = forecast.hourly;
    var offsetMs = (forecast.utc_offset_seconds || 0) * 1000;
    var targetUtcMs = (timeUtc instanceof Date) ? timeUtc.getTime() : (typeof timeUtc === 'number' ? timeUtc : Date.now());

    var times = h.time;
    var n = times.length;
    var tUtcList = [];
    for (var i = 0; i < n; i++) {
      var tStr = times[i].indexOf('Z') === -1 ? times[i] + 'Z' : times[i];
      tUtcList.push(Date.parse(tStr) - offsetMs);
    }

    /* 边界处理：早于第一条或晚于最后一条 */
    if (targetUtcMs <= tUtcList[0]) {
      return extractByIndex(h, 0);
    }
    if (targetUtcMs >= tUtcList[n - 1]) {
      return extractByIndex(h, n - 1);
    }

    /* 寻找包含 targetUtcMs 的相邻两小时索引 [idx1, idx2] */
    var idx1 = 0, idx2 = 1;
    for (var j = 0; j < n - 1; j++) {
      if (targetUtcMs >= tUtcList[j] && targetUtcMs <= tUtcList[j + 1]) {
        idx1 = j;
        idx2 = j + 1;
        break;
      }
    }

    var dt = tUtcList[idx2] - tUtcList[idx1];
    var alpha = dt > 0 ? (targetUtcMs - tUtcList[idx1]) / dt : 0;
    alpha = Math.max(0, Math.min(1, alpha));

    return interpolateHourlyByIndex(h, idx1, idx2, alpha);
  }

  function extractByIndex(h, idx) {
    function val(k, dflt) {
      return (h[k] && h[k][idx] != null) ? h[k][idx] : dflt;
    }
    return {
      cloud_cover: val('cloud_cover', 0),
      cloud_cover_low: val('cloud_cover_low', 0),
      cloud_cover_mid: val('cloud_cover_mid', 0),
      cloud_cover_high: val('cloud_cover_high', 0),
      wind_speed_10m: val('wind_speed_10m', 0),
      wind_direction_10m: val('wind_direction_10m', 0),
      wind_gusts_10m: val('wind_gusts_10m', null),
      visibility: val('visibility', 10000),
      relative_humidity_2m: val('relative_humidity_2m', 50),
      precipitation: val('precipitation', 0),
      precipitation_probability: val('precipitation_probability', 0),
      surface_pressure: val('surface_pressure', null),
      /* 真实高空等压面风场 (850/700/500hPa) */
      wind_speed_850hPa: val('wind_speed_850hPa', null),
      wind_direction_850hPa: val('wind_direction_850hPa', null),
      wind_speed_700hPa: val('wind_speed_700hPa', null),
      wind_direction_700hPa: val('wind_direction_700hPa', null),
      wind_speed_500hPa: val('wind_speed_500hPa', null),
      wind_direction_500hPa: val('wind_direction_500hPa', null)
    };
  }

  function interpolateHourlyByIndex(h, i1, i2, alpha) {
    function scalar(k, dflt) {
      var arr = h[k];
      if (!arr || arr.length <= i1) return dflt;
      var v1 = arr[i1] != null ? arr[i1] : dflt;
      var v2 = arr[i2] != null ? arr[i2] : v1;
      if (v1 == null && v2 == null) return dflt;
      if (v1 == null) return v2;
      if (v2 == null) return v1;
      return v1 * (1 - alpha) + v2 * alpha;
    }

    function angle(k, dflt) {
      var arr = h[k];
      if (!arr || arr.length <= i1) return dflt;
      var a1 = arr[i1] != null ? arr[i1] : dflt;
      var a2 = arr[i2] != null ? arr[i2] : a1;
      if (a1 == null && a2 == null) return dflt;
      if (a1 == null) return a2;
      if (a2 == null) return a1;
      var diff = ((a2 - a1 + 540) % 360) - 180;
      return ((a1 + alpha * diff + 360) % 360);
    }

    return {
      cloud_cover: Math.round(scalar('cloud_cover', 0)),
      cloud_cover_low: Math.round(scalar('cloud_cover_low', 0)),
      cloud_cover_mid: Math.round(scalar('cloud_cover_mid', 0)),
      cloud_cover_high: Math.round(scalar('cloud_cover_high', 0)),
      wind_speed_10m: Number(scalar('wind_speed_10m', 0).toFixed(1)),
      wind_direction_10m: Math.round(angle('wind_direction_10m', 0)),
      wind_gusts_10m: h.wind_gusts_10m ? Number(scalar('wind_gusts_10m', 0).toFixed(1)) : null,
      visibility: Math.round(scalar('visibility', 10000)),
      relative_humidity_2m: Math.round(scalar('relative_humidity_2m', 50)),
      precipitation: Number(scalar('precipitation', 0).toFixed(2)),
      precipitation_probability: Math.round(scalar('precipitation_probability', 0)),
      surface_pressure: h.surface_pressure ? Number(scalar('surface_pressure', 1013).toFixed(1)) : null,
      /* 真实高空等压面风场 (850/700/500hPa) */
      wind_speed_850hPa: h.wind_speed_850hPa ? Number(scalar('wind_speed_850hPa', null).toFixed(1)) : null,
      wind_direction_850hPa: h.wind_direction_850hPa ? Math.round(angle('wind_direction_850hPa', null)) : null,
      wind_speed_700hPa: h.wind_speed_700hPa ? Number(scalar('wind_speed_700hPa', null).toFixed(1)) : null,
      wind_direction_700hPa: h.wind_direction_700hPa ? Math.round(angle('wind_direction_700hPa', null)) : null,
      wind_speed_500hPa: h.wind_speed_500hPa ? Number(scalar('wind_speed_500hPa', null).toFixed(1)) : null,
      wind_direction_500hPa: h.wind_direction_500hPa ? Math.round(angle('wind_direction_500hPa', null)) : null
    };
  }

  /**
   * 兼容保留旧版签名，内部直接采用高精度时序插值
   */
  function extractHourlyAt(forecast, timeUtc) {
    return extractInterpolatedAt(forecast, timeUtc);
  }

  /**
   * 将采样预报数据构建为 360° 全天空云场对象 (CloudField)
   */
  function buildCloudField(samples, timeUtc) {
    var centerNode = null;
    var nodeMap = {};
    var nodeList = [];

    var totalSum = 0, lowSum = 0, midSum = 0, highSum = 0;
    var validCount = 0;

    (samples || []).forEach(function (s) {
      var pt = s.point || {};
      var data = extractInterpolatedAt(s.forecast, timeUtc);
      var record = {
        key: pt.key || (pt.direction + '_' + pt.distanceKm),
        direction: pt.direction,
        azimuth: pt.azimuth != null ? pt.azimuth : 0,
        distanceKm: pt.distanceKm,
        latitude: pt.latitude,
        longitude: pt.longitude,
        data: data || {
          cloud_cover: 0,
          cloud_cover_low: 0,
          cloud_cover_mid: 0,
          cloud_cover_high: 0,
          wind_speed_10m: 0,
          wind_direction_10m: 0
        },
        hasData: !!data
      };

      if (pt.distanceKm === 0 || pt.direction === 'CENTER') {
        centerNode = record;
      } else {
        nodeList.push(record);
        nodeMap[record.key] = record;
      }

      if (data) {
        totalSum += data.cloud_cover;
        lowSum += data.cloud_cover_low;
        midSum += data.cloud_cover_mid;
        highSum += data.cloud_cover_high;
        validCount++;
      }
    });

    var count = validCount || 1;
    var avgTotal = Math.round(totalSum / count);
    var avgLow = Math.round(lowSum / count);
    var avgMid = Math.round(midSum / count);
    var avgHigh = Math.round(highSum / count);

    /* 计算空间云量方差（空间不均一度） */
    var varianceSum = 0;
    nodeList.forEach(function (n) {
      if (n.hasData) {
        var diff = n.data.cloud_cover - avgTotal;
        varianceSum += diff * diff;
      }
    });
    var spatialVariance = Math.round(Math.sqrt(varianceSum / (count || 1)));

    return {
      timestamp: (timeUtc instanceof Date) ? timeUtc.getTime() : (typeof timeUtc === 'number' ? timeUtc : Date.now()),
      center: centerNode || {
        data: { cloud_cover: avgTotal, cloud_cover_low: avgLow, cloud_cover_mid: avgMid, cloud_cover_high: avgHigh, wind_speed_10m: 0, wind_direction_10m: 0 }
      },
      nodes: nodeList,
      nodeMap: nodeMap,
      summary: {
        avgCloudCover: avgTotal,
        avgCloudLow: avgLow,
        avgCloudMid: avgMid,
        avgCloudHigh: avgHigh,
        spatialVariance: spatialVariance,
        nodeCount: nodeList.length + 1,
        validCount: validCount
      },

      /**
       * 沿指定方位射线获取节点（按距离升序排列）
       */
      getByRay: function (dirOrAzimuth) {
        return nodeList.filter(function (n) {
          if (typeof dirOrAzimuth === 'string') {
            return n.direction === dirOrAzimuth;
          }
          var diff = Math.abs(n.azimuth - dirOrAzimuth);
          return Math.min(diff, 360 - diff) < 22.5;
        }).sort(function (a, b) { return a.distanceKm - b.distanceKm; });
      },

      /**
       * 获取指定方位角扇形（走廊切片）内的节点
       */
      getCorridorSlice: function (azimuthDeg, halfWidthDeg) {
        var hw = halfWidthDeg || 35;
        return nodeList.filter(function (n) {
          var diff = Math.abs(n.azimuth - azimuthDeg);
          var ang = Math.min(diff, 360 - diff);
          return ang <= hw;
        });
      },

      /**
       * 获取指定同心距离环上的全部 8 个节点
       */
      getDistanceRing: function (distanceKm) {
        return nodeList.filter(function (n) {
          return Math.abs(n.distanceKm - distanceKm) < 25;
        });
      },

      /**
       * 提取 96 状态数组 [8方向 × 4距离 × 3高度]
       */
      extractStateMatrix: function () {
        var matrix = [];
        DIRECTIONS.forEach(function (dir) {
          DISTANCES_KM.forEach(function (dist) {
            var n = nodeMap[dir + '_' + dist];
            var d = (n && n.data) ? n.data : { cloud_cover_low: 0, cloud_cover_mid: 0, cloud_cover_high: 0 };
            matrix.push({ direction: dir, distanceKm: dist, level: 'LOW', value: d.cloud_cover_low });
            matrix.push({ direction: dir, distanceKm: dist, level: 'MID', value: d.cloud_cover_mid });
            matrix.push({ direction: dir, distanceKm: dist, level: 'HIGH', value: d.cloud_cover_high });
          });
        });
        return matrix;
      }
    };
  }

  /**
   * 从 33 点全天空网格样本中，按日落方位角在同心环上插值出走廊 13 节点虚拟时序样本（解决问题 5）
   * 包含：1 本地中心点 + 4 距离 × 3 方位偏角 (-30°, 0°, +30°) = 13 节点
   */
  function interpolateCorridorSamples(skySamples, centerLat, centerLon, sunsetAzimuthDeg, distancesKm, azimuthOffsets) {
    var dists = distancesKm || DISTANCES_KM;
    var offsets = azimuthOffsets || [-30, 0, 30];
    var centerSample = null;
    var ringMap = {}; /* { '50': [samples for 8 dirs], ... } */

    (skySamples || []).forEach(function (s) {
      var pt = s.point || {};
      if (pt.distanceKm === 0 || pt.direction === 'CENTER') {
        centerSample = s;
      } else {
        var d = pt.distanceKm;
        ringMap[d] = ringMap[d] || {};
        ringMap[d][pt.direction] = s;
      }
    });

    var localPt = (centerSample && centerSample.point) || {
      latitude: centerLat,
      longitude: centerLon,
      distanceKm: 0,
      azimuthOffset: 0,
      role: 'local',
      weight: 1.0
    };

    var corridorSamples = [{
      point: localPt,
      forecast: centerSample ? centerSample.forecast : null
    }];

    offsets.forEach(function (offset) {
      var bearing = ((sunsetAzimuthDeg + offset + 360) % 360);
      var role = offset === 0 ? 'corridor' : 'bank';
      var weight = offset === 0 ? 0.9 : 0.6;

      /* 寻找方位角相邻的两个 8 方位射线 */
      var dirIdx1 = 0, dirIdx2 = 1;
      var fracAz = 0;
      for (var i = 0; i < AZIMUTHS.length; i++) {
        var a1 = AZIMUTHS[i];
        var a2 = (i === AZIMUTHS.length - 1) ? 360 : AZIMUTHS[i + 1];
        if (bearing >= a1 && bearing <= a2) {
          dirIdx1 = i;
          dirIdx2 = (i === AZIMUTHS.length - 1) ? 0 : i + 1;
          fracAz = (bearing - a1) / (a2 - a1);
          break;
        }
      }
      var d1Name = DIRECTIONS[dirIdx1];
      var d2Name = DIRECTIONS[dirIdx2];

      dists.forEach(function (dist) {
        var ptCoords = SS.data.destinationPoint(centerLat, centerLon, bearing, dist);
        var targetPoint = {
          latitude: ptCoords.latitude,
          longitude: ptCoords.longitude,
          distanceKm: dist,
          azimuthOffset: offset,
          role: role,
          weight: weight
        };

        var ringObj = ringMap[dist] || {};
        var s1 = ringObj[d1Name];
        var s2 = ringObj[d2Name];

        if (!s1 || !s1.forecast) {
          corridorSamples.push({
            point: targetPoint,
            forecast: (s2 && s2.forecast) ? s2.forecast : (centerSample ? centerSample.forecast : null)
          });
          return;
        }
        if (!s2 || !s2.forecast) {
          corridorSamples.push({ point: targetPoint, forecast: s1.forecast });
          return;
        }

        /* 对 s1 与 s2 预报时序进行逐小时角度插值 */
        var h1 = s1.forecast.hourly;
        var h2 = s2.forecast.hourly;
        if (!h1 || !h2 || !h1.time) {
          corridorSamples.push({ point: targetPoint, forecast: s1.forecast });
          return;
        }

        var len = Math.min(h1.time.length, h2.time ? h2.time.length : h1.time.length);
        var virtualHourly = {};

        Object.keys(h1).forEach(function (k) {
          if (!Array.isArray(h1[k])) {
            virtualHourly[k] = h1[k];
            return;
          }
          var arr1 = h1[k];
          var arr2 = (h2 && Array.isArray(h2[k])) ? h2[k] : arr1;
          var resArr = new Array(len);

          if (k.indexOf('direction') !== -1) {
            /* 角度平滑插值 */
            for (var t = 0; t < len; t++) {
              var ang1 = arr1[t] != null ? arr1[t] : 0;
              var ang2 = arr2[t] != null ? arr2[t] : ang1;
              var dAng = ((ang2 - ang1 + 540) % 360) - 180;
              resArr[t] = Math.round((ang1 + fracAz * dAng + 360) % 360);
            }
          } else {
            /* 标量线性插值 */
            for (var t2 = 0; t2 < len; t2++) {
              var val1 = arr1[t2] != null ? arr1[t2] : 0;
              var val2 = arr2[t2] != null ? arr2[t2] : val1;
              resArr[t2] = typeof val1 === 'number'
                ? (Math.round((val1 * (1 - fracAz) + val2 * fracAz) * 100) / 100)
                : val1;
            }
          }
          virtualHourly[k] = resArr;
        });

        var virtualForecast = {
          latitude: ptCoords.latitude,
          longitude: ptCoords.longitude,
          utc_offset_seconds: s1.forecast.utc_offset_seconds || 0,
          timezone: s1.forecast.timezone,
          hourly: virtualHourly
        };

        corridorSamples.push({
          point: targetPoint,
          forecast: virtualForecast
        });
      });
    });

    return corridorSamples;
  }

  SS.cloudField = {
    DIRECTIONS: DIRECTIONS,
    AZIMUTHS: AZIMUTHS,
    DISTANCES_KM: DISTANCES_KM,
    generateGridNodes: generateGridNodes,
    extractHourlyAt: extractHourlyAt,
    extractInterpolatedAt: extractInterpolatedAt,
    buildCloudField: buildCloudField,
    interpolateCorridorSamples: interpolateCorridorSamples
  };
})(typeof window !== 'undefined' ? window : globalThis);
