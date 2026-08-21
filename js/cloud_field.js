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
   * 从预报时序中安全提取时刻数据（支持线性插值或就近取值）
   */
  function extractHourlyAt(forecast, timeUtc) {
    if (!forecast || !forecast.hourly || !forecast.hourly.time || !forecast.hourly.time.length) {
      return null;
    }
    var h = forecast.hourly;
    var offsetMs = (forecast.utc_offset_seconds || 0) * 1000;
    var targetUtcMs = (timeUtc instanceof Date) ? timeUtc.getTime() : (typeof timeUtc === 'number' ? timeUtc : Date.now());
    var idx = -1;
    var bestDiff = Infinity;
    for (var i = 0; i < h.time.length; i++) {
      /* Open-Meteo 返回的 h.time[i] 是当地时间 ISO 字符串（如 '2026-08-21T15:00'），
         减去 offsetMs 转换为准确的 UTC 毫秒时间与 targetUtcMs 进行比较 */
      var nodeUtcMs = Date.parse(h.time[i]) - offsetMs;
      var diff = Math.abs(nodeUtcMs - targetUtcMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        idx = i;
      }
    }
    if (idx < 0) return null;

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
      precipitation: val('precipitation', 0)
    };
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
      var data = extractHourlyAt(s.forecast, timeUtc);
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
      timestamp: timeUtc ? timeUtc.getTime() : Date.now(),
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

  SS.cloudField = {
    DIRECTIONS: DIRECTIONS,
    AZIMUTHS: AZIMUTHS,
    DISTANCES_KM: DISTANCES_KM,
    generateGridNodes: generateGridNodes,
    extractHourlyAt: extractHourlyAt,
    buildCloudField: buildCloudField
  };
})(typeof window !== 'undefined' ? window : globalThis);
