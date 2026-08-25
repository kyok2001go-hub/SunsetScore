/* ============================================================
 * SunsetScore V2.2.1 - 极简基线参考模型与实况观测回测闭环 (Baseline & Feedback Engine)
 * 职责：
 *   1. 提供透明、无复杂多层经验调参的极简晚霞基准模型 (SS.baseline.compute)
 *   2. 作为对照组，客观评估高级动力学模型相对于基线模型的增益
 *   3. 提供用户实况观测反馈的持久化存储与回测数据导出 (JSON/CSV)
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var STORAGE_KEY = 'sunsetscore_feedback_v22';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function gauss(v, center, width) {
    var d = (v - center) / width;
    return 100 * Math.exp(-0.5 * d * d);
  }

  /**
   * 极简基线模型：纯基于日落时刻日落方向高中云单峰函数 + 低云遮挡惩罚 + 能见度修正
   * @param {object} ectx 执行上下文
   * @param {Array} corridorSamples 走廊样本
   * @returns {{score: number, level: string, formula: string, components: object}}
   */
  function compute(ectx, corridorSamples) {
    var samples = corridorSamples || [];
    var localSample = null;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].point && samples[i].point.distanceKm === 0) {
        localSample = samples[i];
        break;
      }
    }
    if (!localSample || !localSample.forecast || !localSample.forecast.hourly) {
      return { score: 50, level: '一般', formula: '无数据兜底', components: {} };
    }

    var h = localSample.forecast.hourly;
    var idx = SS.engine.hourIndex(h.time, ectx.sunsetLocal);
    if (idx < 0) idx = 0;

    function at(key, dflt) {
      return (h[key] && h[key][idx] != null) ? h[key][idx] : dflt;
    }

    var low = at('cloud_cover_low', 0);
    var mid = at('cloud_cover_mid', 0);
    var high = at('cloud_cover_high', 0);
    var visM = at('visibility', 10000);
    var precip = at('precipitation', 0);

    /* 走廊远端 (50~100km) 中高云与低云辅助均值 */
    var farHighs = [], farMids = [], farLows = [];
    samples.forEach(function (s) {
      if (s.forecast && s.forecast.hourly && s.point && s.point.distanceKm > 0 && s.point.distanceKm <= 100) {
        var fh = s.forecast.hourly;
        var j = SS.engine.hourIndex(fh.time, ectx.sunsetLocal);
        if (j >= 0) {
          if (fh.cloud_cover_high && fh.cloud_cover_high[j] != null) farHighs.push(fh.cloud_cover_high[j]);
          if (fh.cloud_cover_mid && fh.cloud_cover_mid[j] != null) farMids.push(fh.cloud_cover_mid[j]);
          if (fh.cloud_cover_low && fh.cloud_cover_low[j] != null) farLows.push(fh.cloud_cover_low[j]);
        }
      }
    });

    function avg(arr, dflt) {
      if (!arr.length) return dflt;
      var s = 0;
      for (var k = 0; k < arr.length; k++) s += arr[k];
      return s / arr.length;
    }

    var effHigh = Math.round(0.6 * high + 0.4 * avg(farHighs, high));
    var effMid = Math.round(0.6 * mid + 0.4 * avg(farMids, mid));
    var effLow = Math.round(0.6 * low + 0.4 * avg(farLows, low));
    var visKm = Math.max(0.1, visM / 1000);

    /* 1. 中高云受光得分 (高云中心50%、中云中心40%) */
    var highOpt = gauss(effHigh, 50, 25);
    var midOpt = gauss(effMid, 40, 25);
    var cloudPotential = 0.65 * highOpt + 0.35 * midOpt;

    /* 2. 低云遮挡惩罚 */
    var lowPenalty = clamp(1.0 - Math.pow(effLow / 100, 1.3), 0.05, 1.0);

    /* 3. 大气通透度因子 */
    var visFactor = clamp(visKm / 15, 0.3, 1.0);

    /* 4. 降水硬惩罚 */
    var precipPenalty = precip > 0.5 ? 0.3 : (precip > 0.1 ? 0.7 : 1.0);

    var rawScore = cloudPotential * lowPenalty * visFactor * precipPenalty;
    var finalScore = Math.round(clamp(rawScore, 5, 95));

    var level = '一般';
    var levels = SS.config.levels || [];
    for (var l = 0; l < levels.length; l++) {
      if (finalScore >= levels[l].min) { level = levels[l].label; break; }
    }

    return {
      score: finalScore,
      level: level,
      formula: 'CloudPotential(' + Math.round(cloudPotential) + ') × LowPenalty(' + lowPenalty.toFixed(2) + ') × VisFactor(' + visFactor.toFixed(2) + ')',
      components: {
        cloudPotential: Math.round(cloudPotential),
        lowPenalty: Number(lowPenalty.toFixed(2)),
        visFactor: Number(visFactor.toFixed(2)),
        precipPenalty: precipPenalty,
        effHigh: effHigh,
        effMid: effMid,
        effLow: effLow,
        visKm: Number(visKm.toFixed(1))
      }
    };
  }

  /* ---------- 实况观测反馈与回测存储 ---------- */

  function getFeedbackList() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveFeedback(record) {
    try {
      var list = getFeedbackList();
      record.id = 'fb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      record.savedAt = new Date().toISOString();
      list.unshift(record);
      if (list.length > 300) list = list.slice(0, 300); /* 保留最近 300 条 */
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return record;
    } catch (e) {
      return null;
    }
  }

  function clearFeedback() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function exportFeedbackJson() {
    var list = getFeedbackList();
    return JSON.stringify(list, null, 2);
  }

  function generateQueryId() {
    return 'qid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 提交实况反馈（本地存储 + 异步上报至 Cloudflare D1）
   * @param {object} payload 完整特征对数据
   * @returns {Promise<{local: boolean, remote: boolean, id: string, message?: string}>}
   */
  function submitFeedback(payload) {
    if (!payload.query_id) {
      payload.query_id = generateQueryId();
    }
    var localRecord = saveFeedback(payload);
    var localId = localRecord ? localRecord.id : ('fb_' + Date.now());

    /* 异步向 Cloudflare Pages Functions /api/feedback 发送入库请求 */
    if (typeof fetch === 'function') {
      return fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (errJson) {
            return { local: true, remote: false, id: localId, error: errJson.error || ('HTTP ' + res.status) };
          });
        }
        return res.json().then(function (data) {
          return { local: true, remote: true, id: data.id || localId, message: data.message };
        });
      }).catch(function (netErr) {
        /* 网络离线或静态环境（如 file:// 本地预览），保持本地有效 */
        return { local: true, remote: false, id: localId, error: netErr.message || '网络请求失败' };
      });
    }

    return Promise.resolve({ local: true, remote: false, id: localId });
  }

  SS.baseline = {
    compute: compute,
    generateQueryId: generateQueryId,
    getFeedbackList: getFeedbackList,
    saveFeedback: saveFeedback,
    submitFeedback: submitFeedback,
    clearFeedback: clearFeedback,
    exportFeedbackJson: exportFeedbackJson
  };
})(typeof window !== 'undefined' ? window : globalThis);

