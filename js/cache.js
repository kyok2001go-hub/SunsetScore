/* ============================================================
 * SunsetScore V1.5 - 浏览器缓存（第 28 章）
 * 以"城市+日期"为 key，避免同一用户短时间内重复请求 API
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function storageAvailable() {
    try {
      var k = '__ss_test__';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  var memCache = {}; /* localStorage 不可用时的降级方案 */
  var hasStorage = storageAvailable();

  SS.cache = {
    /**
     * 读取未过期的缓存
     * @param {string} key
     * @returns {*} 缓存值或 null
     */
    get: function (key) {
      try {
        var raw = hasStorage ? root.localStorage.getItem(SS.config.cachePrefix + key) : memCache[key];
        if (!raw) return null;
        var item = JSON.parse(raw);
        if (!item || typeof item.expires !== 'number') return null;
        if (Date.now() > item.expires) {
          this.remove(key);
          return null;
        }
        return item.value;
      } catch (e) {
        return null;
      }
    },

    /**
     * 写入缓存
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMinutes] 默认使用 config.cacheTtlMinutes
     */
    set: function (key, value, ttlMinutes) {
      var ttl = (ttlMinutes || SS.config.cacheTtlMinutes) * 60000;
      var item = JSON.stringify({ expires: Date.now() + ttl, value: value });
      try {
        if (hasStorage) {
          root.localStorage.setItem(SS.config.cachePrefix + key, item);
        } else {
          memCache[key] = item;
        }
      } catch (e) { /* 存储满或隐私模式下静默失败 */ }
    },

    remove: function (key) {
      try {
        if (hasStorage) root.localStorage.removeItem(SS.config.cachePrefix + key);
        delete memCache[key];
      } catch (e) { /* 忽略 */ }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
