/* City-level selection policy shared by autocomplete and direct prediction. */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var cache = new Map();
  var administrativeSeats = Object.assign(Object.create(null), { PPLC: 5, PPLG: 5, PPLA: 4, PPLA2: 3, PPLA3: 2 });
  // Query/name aliases only: coordinates and IDs must still come from the provider.
  var cityAliases = [
    { names: ['台北', 'taipei'], query: 'Taipei' },
    { names: ['旧金山', '舊金山', 'san francisco'], query: 'San Francisco' }
  ];
  // Province-only input must not resolve to an unrelated namesake village/city.
  // Municipalities (Beijing/Shanghai/Tianjin/Chongqing) and Hong Kong/Macao remain searchable.
  var provinces = ('河北|hebei|山西|shanxi|辽宁|遼寧|liaoning|吉林|jilin|黑龙江|黑龍江|heilongjiang|' +
    '江苏|江蘇|jiangsu|浙江|zhejiang|安徽|anhui|福建|fujian|江西|jiangxi|山东|山東|shandong|' +
    '河南|henan|湖北|hubei|湖南|hunan|广东|廣東|guangdong|海南|hainan|四川|sichuan|' +
    '贵州|貴州|guizhou|云南|雲南|yunnan|陕西|陝西|shaanxi|甘肃|甘肅|gansu|' +
    '青海|qinghai|台湾|臺灣|台灣|taiwan|内蒙古|內蒙古|inner mongolia|广西|廣西|guangxi|' +
    '西藏|tibet|xizang|宁夏|寧夏|ningxia|新疆|xinjiang').split('|');

  function normalize(query) {
    return String(query || '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/，/g, ',');
  }
  function cityPart(query) { return normalize(query).split(',')[0].trim(); }
  function regionOnly(query) {
    var part = cityPart(query).toLowerCase().replace(/(?:壮族|壯族|回族|维吾尔|維吾爾)?自治区$|(?:壯族|回族|維吾爾)?自治區$|省$|\s+province$/g, '').trim();
    return provinces.indexOf(part) !== -1;
  }
  function hint(query) {
    if (regionOnly(query)) return '请输入具体城市名称，不支持仅按省份预测。';
    if (cityPart(query).length < 2) return '请输入至少两个字或字母，或输入“纬度,经度”。';
    return '未找到匹配城市，请补全城市名，或尝试英文名、经纬度。';
  }
  function variants(query) {
    var parts = normalize(query).split(',');
    var city = parts[0].trim();
    var result = [normalize(query)];
    if (/^[\u3400-\u9fff]{2,}$/.test(city)) {
      parts[0] = /市$/.test(city) ? city.slice(0, -1) : city + '市';
      if (parts[0].length >= 2) result.push(parts.join(','));
    }
    var alias = findAlias(city);
    if (alias) { parts[0] = alias.query; result.push(parts.join(',')); }
    return Array.from(new Set(result));
  }
  function nameKey(value) { return normalize(value).toLowerCase().replace(/臺/g, '台').replace(/灣/g, '湾').replace(/市$/, ''); }
  function findAlias(value) {
    var key = nameKey(value);
    return cityAliases.find(function (alias) { return alias.names.indexOf(key) !== -1; });
  }
  function cityName(value) { var alias = findAlias(value); return alias ? alias.names[0] : nameKey(value); }
  function displayName(value) {
    // GeoNames can return both traditional variants in one administrative field.
    // Collapse equivalent variants, not arbitrary different administrative names.
    return Array.from(new Set(normalize(value).split(/\s+or\s+/i).map(function (part) {
      return part.replace(/臺/g, '台').replace(/灣/g, '湾');
    }))).join(' or ');
  }
  function regionKey(value) { return cityName(displayName(value)).replace(/省$/, ''); }
  function toLocation(row) {
    if (!row || typeof row.name !== 'string' || !row.name.trim() ||
        !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) ||
        Math.abs(row.latitude) > 90 || Math.abs(row.longitude) > 180) return null;
    if (row.source === 'qweather') {
      if (typeof row.id !== 'string' || !/^qweather:[a-z0-9]{1,32}$/i.test(row.id) ||
          row.feature_code !== 'QW_CITY' || row.country_code !== 'CN' || row.coordinate_system !== 'WGS84') return null;
      return {
        id: row.id, source: 'qweather', name: row.name.trim(), country: '中国', country_code: 'CN',
        admin1: typeof row.admin1 === 'string' ? row.admin1 : '', admin2: typeof row.admin2 === 'string' ? row.admin2 : '',
        latitude: row.latitude, longitude: row.longitude, timezone: typeof row.timezone === 'string' ? row.timezone : 'Asia/Shanghai',
        feature_code: 'QW_CITY', population: 0, rank: Number.isFinite(row.rank) ? row.rank : 100,
        coordinate_system: 'WGS84', original_coordinate_system: 'GCJ-02'
      };
    }
    var population = Number.isFinite(row.population) && row.population >= 0 ? row.population : 0;
    if (!administrativeSeats[row.feature_code] && !(row.feature_code === 'PPL' && population >= SS.config.citySearch.minTownPopulation)) return null;
    return {
      id: Number.isInteger(row.id) && row.id > 0 ? row.id : null,
      source: 'openmeteo', coordinate_system: 'WGS84',
      name: row.name.trim(), country: typeof row.country === 'string' ? row.country : '',
      country_code: typeof row.country_code === 'string' ? row.country_code : '',
      admin1: typeof row.admin1 === 'string' ? row.admin1 : '',
      admin2: typeof row.admin2 === 'string' ? row.admin2 : '',
      latitude: row.latitude, longitude: row.longitude,
      timezone: typeof row.timezone === 'string' ? row.timezone : 'auto',
      feature_code: row.feature_code, population: population
    };
  }
  function detail(location) {
    var seen = new Set([regionKey(location.name)]);
    var country = regionKey(location.country || location.country_code);
    return [location.admin2, location.admin1, location.country || location.country_code]
      .map(displayName).filter(function (value, index) {
        var key = regionKey(value);
        if (!value || seen.has(key) || (index < 2 && key === country)) return false;
        seen.add(key);
        return true;
      }).join(' · ');
  }
  function title(location) {
    var name = displayName(location.name), admin = displayName(location.admin1);
    return name + (admin && regionKey(admin) !== regionKey(name) &&
      regionKey(admin) !== regionKey(location.country) ? ' · ' + admin : '');
  }
  function label(location) { var meta = detail(location); return displayName(location.name) + (meta ? ' · ' + meta : ''); }
  function rankName(location, query) {
    var name = cityName(location.name), search = cityName(cityPart(query));
    return name === search ? 2 : name.indexOf(search) === 0 ? 1 : 0;
  }
  function directlyMatches(location, query) {
    var search = cityName(cityPart(query));
    return rankName(location, query) > 0 || (/[\u3400-\u9fff]/.test(search) &&
      cityName(location.admin2).indexOf(search) !== -1);
  }
  function select(rows, query) {
    var seen = new Set();
    return rows.map(toLocation).filter(function (location) {
      if (!location) return false;
      var key = location.id ? location.source + ':' + location.id : [location.name, location.country_code, location.admin1,
        location.latitude.toFixed(4), location.longitude.toFixed(4)].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort(function (a, b) {
      // Explicit name/alias matches outrank unrelated domestic fuzzy matches.
      // Prefer the domestic source only at the same name-match quality.
      return rankName(b, query) - rankName(a, query) ||
        Number(b.source === 'qweather') - Number(a.source === 'qweather') ||
        (a.source === 'qweather' && b.source === 'qweather' ? a.rank - b.rank : 0) || b.population - a.population ||
        (administrativeSeats[b.feature_code] || 1) - (administrativeSeats[a.feature_code] || 1);
    }).slice(0, SS.config.citySearch.resultLimit);
  }
  function copyCandidates(items) {
    var copy = items.map(function (item) { return Object.assign({}, item); });
    ['partial', 'requiresSelection', 'warning'].forEach(function (key) { if (items[key] != null) copy[key] = items[key]; });
    return copy;
  }
  async function search(query, options) {
    query = normalize(query);
    options = options || {};
    SS.network.throwIfAborted(options.signal);
    if (query.length > 60 || cityPart(query).length < 2 || regionOnly(query)) return [];
    var key = query.toLowerCase(), saved = cache.get(key);
    if (saved && saved.expires > Date.now()) return copyCandidates(saved.items);
    cache.delete(key);
    async function capture(source, action) {
      try { return { source: source, rows: await action() }; }
      catch (error) { SS.network.throwIfAborted(options.signal); return { source: source, error: error }; }
    }
    var replies = await Promise.all([
      capture('qweather', function () { return SS.data.searchDomesticLocations(query, options); }),
      ...variants(query).map(function (name) {
        return capture('openmeteo', async function () {
          var rows = await SS.data.searchLocations(name, options);
          // Never re-introduce mainland GeoNames mistakes, even when QWeather fails.
          return rows.filter(function (row) { return row && typeof row.country_code === 'string' && row.country_code.toUpperCase() !== 'CN'; });
        });
      })
    ]);
    SS.network.throwIfAborted(options.signal);
    var items = select(replies.reduce(function (all, reply) { return all.concat(reply.rows || []); }, []), query);
    var failed = replies.find(function (reply) { return reply.error; });
    if (!items.length && failed) throw failed.error;
    var output = copyCandidates(items);
    if (failed) {
      output.partial = true;
      output.requiresSelection = !!replies.find(function (reply) { return reply.source === 'qweather' && reply.error; });
      output.warning = output.requiresSelection ? '国内城市检索暂不可用；以下仅为国外候选，请核对后点击选择，或点击搜索重试。'
        : '国外候选暂不可用；以下为国内城市，可选择或直接搜索。';
    }
    if (!output.requiresSelection && output[0] && !directlyMatches(output[0], query)) {
      // The provider may return broad fuzzy matches (or translated/traditional aliases).
      // Keep them selectable, but do not silently predict an unrelated city.
      output.requiresSelection = true;
      output.warning = '未找到名称直接匹配的城市；以下为近似候选，请核对后点击选择。';
    }
    // Do not cache an empty/partial/error result, so retry can recover immediately.
    if (output.length && !failed) {
      cache.set(key, { items: output, expires: Date.now() + SS.config.citySearch.cacheMinutes * 60000 });
      while (cache.size > SS.config.citySearch.maxCacheEntries) cache.delete(cache.keys().next().value);
    }
    return copyCandidates(output);
  }
  SS.citySearch = {
    normalize: normalize, hint: hint, variants: variants, select: select,
    toLocation: toLocation, detail: detail, label: label, title: title, displayName: displayName, search: search,
    resolve: async function (query, options) {
      var items = await search(query, options);
      if (!items.length) throw new Error(hint(query));
      if (items.requiresSelection) throw new Error(items.warning);
      return items[0];
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
