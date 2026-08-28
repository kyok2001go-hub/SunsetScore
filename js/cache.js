/* ============================================================
 * SunsetScore V1.8 - 浏览器缓存层（方案 10-11、15 章）
 * - 以"数据类型+坐标+日期"为 key，避免重复请求 API
 * - Fresh / Stale 双语义：过期缓存在 staleMaxAge 内仍可作降级回退
 * - localStorage 不可用时降级为内存缓存
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

  function readRaw(key) {
    try {
      var raw = hasStorage ? root.localStorage.getItem(SS.config.cachePrefix + key) : memCache[key];
      if (!raw) return null;
      var item = JSON.parse(raw);
      if (!item || typeof item.expiresAt !== 'number') return null;
      if (item.schemaVersion !== SS.version.schema) return null;
      return item;
    } catch (e) {
      return null;
    }
  }

  /* V1.8 缓存 key 构造器：含空间模型版本（cachePrefix）与采样模式，
     避免未来修改采样规则时旧缓存污染新算法（方案 10.1 节） */
  SS.cacheKeys = {
    coord: function (lat, lon) { return lat.toFixed(4) + '_' + lon.toFixed(4); },
    forecast: function (date, lat, lon) { return 'forecast_' + date + '_' + SS.cacheKeys.coord(lat, lon); },
    spatial: function (date, lat, lon, azimuthDeg, mode) {
      return 'spatial_' + date + '_' + SS.cacheKeys.coord(lat, lon) + '_' +
        Math.round(azimuthDeg) + '_' + mode;
    },
    air: function (date, lat, lon) { return 'air_' + date + '_' + SS.cacheKeys.coord(lat, lon); },
    solar: function (date, lat, lon) { return 'solar_' + date + '_' + SS.cacheKeys.coord(lat, lon); },
    /* V1.9 Nowcasting：type = precip / radar / satellite */
    nowcast: function (type, date, lat, lon) { return 'nowcast_' + type + '_' + date + '_' + SS.cacheKeys.coord(lat, lon) +
        (type === 'precip' ? '_qw_' + SS.config.nowcast.qweather.enabled : ''); },
    /* V2.1 全天空 360° 云场缓存 */
    cloudField: function (date, lat, lon) { return 'cloudfield_' + date + '_' + SS.cacheKeys.coord(lat, lon); }
  };

  SS.cache = {
    /**
     * 读取未过期（FRESH）的缓存
     * @param {string} key
     * @returns {*} 缓存值或 null
     */
    get: function (key) {
      var item = readRaw(key);
      if (!item) return null;
      if (Date.now() > item.expiresAt) {
        this.remove(key);
        return null;
      }
      return item.data;
    },

    /**
     * V1.8：带状态读取（方案 15 章）
     * FRESH：未过期，直接使用；
     * STALE：已过期但在 staleMaxAgeHours 内，仅作 API 失败时的降级回退；
     * MISS：不存在或已彻底失效。
     * @returns {{value: *, status: string, ageMinutes: number}}
     */
    getWithStatus: function (key, staleMaxHours) {
      var miss = { value: null, status: 'MISS', ageMinutes: 0 };
      var item = readRaw(key);
      if (!item) return miss;

      var now = Date.now();
      /* 兼容 V1.7 旧条目（无 savedAt）：按默认 TTL 反推写入时刻 */
      var savedAt = item.createdAt;
      var ageMinutes = Math.max(0, Math.round((now - savedAt) / 60000));

      if (now <= item.expiresAt) {
        return { value: item.data, status: 'FRESH', ageMinutes: ageMinutes };
      }
      var staleLimitHours = staleMaxHours != null
        ? staleMaxHours
        : (SS.config.cachePolicy ? SS.config.cachePolicy.staleMaxAgeHours : 24);
      if (now - savedAt <= staleLimitHours * 3600000) {
        return { value: item.data, status: 'STALE', ageMinutes: ageMinutes };
      }
      this.remove(key);
      return miss;
    },

    /**
     * 写入缓存
     * @param {string} key
     * @param {*} value
     * @param {number} [ttlMinutes] 默认使用 config.cacheTtlMinutes
     */
    set: function (key, value, ttlMinutes) {
      var ttl = (ttlMinutes || SS.config.cacheTtlMinutes) * 60000;
      var now = Date.now();
      var item = JSON.stringify({
        schemaVersion: SS.version.schema,
        createdAt: now,
        expiresAt: now + ttl,
        data: value
      });
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
