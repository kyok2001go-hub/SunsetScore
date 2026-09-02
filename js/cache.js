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
      /* 配额已满时仍允许读取和清理已有条目，不能直接退化为不可用。 */
      try {
        return !!root.localStorage && e && e.name === 'QuotaExceededError' && root.localStorage.length > 0;
      } catch (ignored) {
        return false;
      }
    }
  }

  var memCache = {}; /* localStorage 不可用时的降级方案 */
  var hasStorage = storageAvailable();

  function storageKeys() {
    var keys = [];
    if (!hasStorage) return keys;
    try {
      for (var i = 0; i < root.localStorage.length; i++) {
        var key = root.localStorage.key(i);
        if (typeof key === 'string') keys.push(key);
      }
    } catch (e) { /* localStorage 可能在运行时被浏览器禁用 */ }
    return keys;
  }

  function parseEnvelope(raw) {
    try {
      var item = JSON.parse(raw);
      return item && typeof item.expiresAt === 'number' ? item : null;
    } catch (e) {
      return null;
    }
  }

  function storageGet(key) {
    try { return root.localStorage.getItem(key); }
    catch (e) { return null; }
  }

  function cleanupStorage(now) {
    if (!hasStorage) return;
    storageKeys().forEach(function (fullKey) {
      /* 只清理 SunsetScore 数据缓存，绝不触碰反馈备份和反馈冷却键。 */
      if (fullKey.indexOf('sunsetscore_v') !== 0) return;
      var obsolete = fullKey.indexOf(SS.config.cachePrefix) !== 0;
      var item = obsolete ? null : parseEnvelope(storageGet(fullKey));
      if (obsolete || !item || item.schemaVersion !== SS.version.schema || now > item.expiresAt) {
        try { root.localStorage.removeItem(fullKey); } catch (e) { /* 忽略单项清理失败 */ }
      }
    });
  }

  function writeStorage(fullKey, item) {
    function attempt() {
      try {
        root.localStorage.setItem(fullKey, item);
        return true;
      } catch (e) {
        return false;
      }
    }
    if (attempt()) return true;

    cleanupStorage(Date.now());
    if (attempt()) return true;

    /* 仍超额时按创建时间淘汰最旧的当前版本缓存，直到本次写入成功。 */
    var victims = storageKeys().filter(function (key) {
      return key !== fullKey && key.indexOf(SS.config.cachePrefix) === 0;
    }).map(function (key) {
      var entry = parseEnvelope(storageGet(key));
      return { key: key, createdAt: entry && Number.isFinite(entry.createdAt) ? entry.createdAt : 0 };
    }).sort(function (a, b) { return a.createdAt - b.createdAt; });

    for (var i = 0; i < victims.length; i++) {
      try { root.localStorage.removeItem(victims[i].key); } catch (e) { /* 继续尝试下一项 */ }
      if (attempt()) return true;
    }
    return false;
  }

  if (hasStorage) cleanupStorage(Date.now());

  function readRaw(key) {
    try {
      var raw = hasStorage ? storageGet(SS.config.cachePrefix + key) : null;
      if (!raw) raw = memCache[key];
      if (!raw) return null;
      var item = parseEnvelope(raw);
      if (!item) return null;
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
      if (hasStorage && writeStorage(SS.config.cachePrefix + key, item)) {
        delete memCache[key];
        return true;
      }
      /* 配额无法恢复或持久存储不可用时，至少保证当前页面内仍可命中。 */
      memCache[key] = item;
      return !hasStorage;
    },

    remove: function (key) {
      try {
        if (hasStorage) root.localStorage.removeItem(SS.config.cachePrefix + key);
        delete memCache[key];
      } catch (e) { /* 忽略 */ }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
