/* ============================================================
 * SunsetScore V2.3 - V2.2.2 全天空雷达原始渲染逻辑模块化迁移
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  function $(id) { return root.document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  var RADAR_DIRS = [
    { dir: 'N', az: 0, label: '北 (N)' },
    { dir: 'NE', az: 45, label: '东北 (NE)' },
    { dir: 'E', az: 90, label: '东 (E)' },
    { dir: 'SE', az: 135, label: '东南 (SE)' },
    { dir: 'S', az: 180, label: '南 (S)' },
    { dir: 'SW', az: 225, label: '西南 (SW)' },
    { dir: 'W', az: 270, label: '西 (W)' },
    { dir: 'NW', az: 315, label: '西北 (NW)' }
  ];
  /* V2.2.2 原始环距：50km(74px) -> 100km(132px) -> 200km(190px) -> 300km(248px)。 */
  var RADAR_DISTS = [50, 100, 200, 300];
  var RADAR_RADII = { 50: 74, 100: 132, 200: 190, 300: 248 };
  var radarVisibleLayers = { low: true, mid: true, high: true };
  var cachedRadarResult = null;
  var radarTogglesBound = false;

  function initRadarLayerToggles() {
    if (radarTogglesBound) return;
    var container = $('radar-layer-toggles');
    if (!container) return;
    var buttons = container.querySelectorAll('.legend-item[data-layer]');
    buttons.forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        var layer = button.getAttribute('data-layer');
        if (!layer) return;
        radarVisibleLayers[layer] = !radarVisibleLayers[layer];
        button.classList.toggle('inactive', !radarVisibleLayers[layer]);
        button.classList.toggle('active', radarVisibleLayers[layer]);
        button.setAttribute('aria-pressed', radarVisibleLayers[layer] ? 'true' : 'false');
        if (cachedRadarResult) renderCloudFieldRadar(cachedRadarResult);
      });
    });
    radarTogglesBound = true;
  }

  /* ---------- V2.5.5.12 显示修复：只改渲染，不取数、不参与评分 ----------
     1. 没有数据的节点画成空心标记并给出说明，不再当作 0% 云量；
     2. 33 点云场降级为日落方向采样点时，把实际取到的节点画在真实方位与距离上；
     3. 圆面积与云量成正比（原为半径成正比，50% 云量只占 1/4 面积），并用扇区底色表示总云量。 */
  var CENTER_X = 310, CENTER_Y = 310;
  var MAX_CLOUD_RADIUS = 28;
  var CENTER_CELL_RADIUS = 37;
  /* 各距离环对应的扇区径向范围（相邻环半径的中点） */
  var RING_BOUNDS = { 50: [37, 103], 100: [103, 161], 200: [161, 219], 300: [219, 248] };
  var SLOT_DIRECTIONS = { N: true, NE: true, E: true, SE: true, S: true, SW: true, W: true, NW: true };

  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function percent(value) { return finite(value) ? Math.max(0, Math.min(100, value)) : 0; }
  function round1(value) { return Math.round(value * 10) / 10; }

  /* 0% 不绘制；其余面积正比于云量，最小 3.2px 保证可见。 */
  function cloudRadius(value) {
    if (!finite(value) || value <= 0) return 0;
    return Math.max(3.2, Math.sqrt(Math.min(100, value) / 100) * MAX_CLOUD_RADIUS);
  }

  /* 任意距离（km）到图上半径的分段线性映射，与四个距离环一致。 */
  function radiusForDistance(distanceKm) {
    var stops = [[0, 0], [50, 74], [100, 132], [200, 190], [300, 248]];
    if (!finite(distanceKm) || distanceKm <= 0) return 0;
    for (var i = 1; i < stops.length; i++) {
      if (distanceKm <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i];
        return a[1] + (b[1] - a[1]) * (distanceKm - a[0]) / (b[0] - a[0]);
      }
    }
    return 248;
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    var x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
      Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  function pointFrom(record, base) {
    var has = !!record && record.hasData !== false && !!record.data;
    var data = has ? record.data : {};
    base.hasData = has;
    base.low = percent(data.cloud_cover_low);
    base.mid = percent(data.cloud_cover_mid);
    base.high = percent(data.cloud_cover_high);
    base.total = percent(data.cloud_cover);
    return base;
  }

  /* 把预测结果整理成绘图用的点集与说明文字；纯函数，便于测试。 */
  function buildRadarModel(result) {
    var cloudField = (result && result.cloud_field) || {};
    var nodes = cloudField.nodes || [];
    var centerNode = cloudField.center || null;
    var used = [];
    var points = [pointFrom(centerNode, {
      key: 'CENTER_0', label: '本地中心 (0km)', azimuth: 0, distanceKm: 0, x: CENTER_X, y: CENTER_Y, slot: true
    })];
    var missing = 0;

    RADAR_DIRS.forEach(function (direction) {
      var angle = direction.az * Math.PI / 180;
      RADAR_DISTS.forEach(function (distance) {
        var ringRadius = RADAR_RADII[distance] || 248;
        var key = direction.dir + '_' + distance;
        var record = cloudField.nodeMap && cloudField.nodeMap[key];
        if (!record) {
          for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].direction === direction.dir && nodes[i].distanceKm === distance) { record = nodes[i]; break; }
          }
        }
        if (record) used.push(record);
        var point = pointFrom(record, {
          key: key, label: direction.label + ' · ' + distance + 'km', azimuth: direction.az, distanceKm: distance,
          x: round1(CENTER_X + ringRadius * Math.sin(angle)), y: round1(CENTER_Y - ringRadius * Math.cos(angle)), slot: true
        });
        if (!point.hasData) missing++;
        points.push(point);
      });
    });

    /* 降级采样点（日落方向 7 / 13 点）不在 8 方位网格上：按真实方位与距离绘制。 */
    var centerLat = centerNode && finite(centerNode.latitude) ? centerNode.latitude : (result ? result.latitude : null);
    var centerLon = centerNode && finite(centerNode.longitude) ? centerNode.longitude : (result ? result.longitude : null);
    var extras = 0;
    nodes.forEach(function (node) {
      if (!node || used.indexOf(node) !== -1 || node.hasData === false || !node.data) return;
      if (SLOT_DIRECTIONS[node.direction] && RADAR_RADII[node.distanceKm]) return;
      if (!finite(node.latitude) || !finite(node.longitude) || !finite(centerLat) || !finite(centerLon) || !(node.distanceKm > 0)) return;
      var azimuth = bearingDeg(centerLat, centerLon, node.latitude, node.longitude);
      var angle = azimuth * Math.PI / 180, radius = radiusForDistance(node.distanceKm);
      extras++;
      points.push(pointFrom(node, {
        key: 'EXTRA_' + extras, label: '日落方向采样点 · 方位 ' + Math.round(azimuth) + '° · ' + Math.round(node.distanceKm) + 'km',
        azimuth: azimuth, distanceKm: node.distanceKm,
        x: round1(CENTER_X + radius * Math.sin(angle)), y: round1(CENTER_Y - radius * Math.cos(angle)), slot: false
      }));
    });

    var note = null;
    if (missing > 0) {
      var tail = '空心标记表示没有数据，不代表无云。';
      if (extras > 0) note = '全天空云场获取失败，本次降级为日落方向 ' + extras + ' 个采样点。' + tail;
      else if (missing === RADAR_DIRS.length * RADAR_DISTS.length) {
        note = (result && result.batch_attempts > 0 ? '周边云场获取失败，本次只有本地节点。' : '本地为浓厚阴天，本次只采样了本地节点。') + tail;
      } else note = missing + ' 个节点暂无数据。' + tail;
    }
    return { points: points, missing: missing, extras: extras, note: note };
  }

  /* 网格节点对应的扇区（中心为圆），用于总云量底色。 */
  function cellPath(point) {
    if (point.distanceKm === 0) {
      return 'M ' + (CENTER_X - CENTER_CELL_RADIUS) + ' ' + CENTER_Y + ' a ' + CENTER_CELL_RADIUS + ' ' + CENTER_CELL_RADIUS + ' 0 1 0 ' +
        (2 * CENTER_CELL_RADIUS) + ' 0 a ' + CENTER_CELL_RADIUS + ' ' + CENTER_CELL_RADIUS + ' 0 1 0 ' + (-2 * CENTER_CELL_RADIUS) + ' 0 Z';
    }
    var bounds = RING_BOUNDS[point.distanceKm];
    if (!bounds) return '';
    var a0 = (point.azimuth - 22.5) * Math.PI / 180, a1 = (point.azimuth + 22.5) * Math.PI / 180;
    function at(radius, angle) { return round1(CENTER_X + radius * Math.sin(angle)) + ' ' + round1(CENTER_Y - radius * Math.cos(angle)); }
    return 'M ' + at(bounds[0], a0) + ' L ' + at(bounds[1], a0) + ' A ' + bounds[1] + ' ' + bounds[1] + ' 0 0 1 ' + at(bounds[1], a1) +
      ' L ' + at(bounds[0], a1) + ' A ' + bounds[0] + ' ' + bounds[0] + ' 0 0 0 ' + at(bounds[0], a0) + ' Z';
  }

  function renderCloudFieldRadar(result) {
    var block = $('cloud-field-radar-block');
    var chart = $('cloud-field-radar-svg');
    var tooltip = $('radar-tooltip');
    if (!block || !chart) return;
    var cloudField = result.cloud_field;
    if (!cloudField || (!cloudField.nodes && !cloudField.nodeMap)) {
      hide(block);
      return;
    }
    show(block);
    cachedRadarResult = result;
    initRadarLayerToggles();

    var centerX = CENTER_X, centerY = CENTER_Y;
    var centerData = (cloudField.center && cloudField.center.data) || {};
    var model = buildRadarModel(result);
    var allPoints = model.points;
    var calculateRadius = cloudRadius;
    var statusNote = $('radar-status-note');
    if (statusNote) {
      statusNote.textContent = model.note || '';
      if (model.note) show(statusNote); else hide(statusNote);
    }

    var cloudMotion = result.cloud_motion || {};
    var wind = cloudMotion.wind || (centerData.wind_speed_10m != null ? centerData : {});
    var windSpeed = wind.speedKmH != null ? wind.speedKmH : (wind.wind_speed_10m || 15);
    var windFrom = wind.directionDeg != null ? wind.directionDeg : (wind.wind_direction_10m || 0);
    var flowHeading = (windFrom + 180) % 360;
    var windDurationNumber = Math.max(1, Math.min(6, 36 / Math.max(3, windSpeed)));
    var windDuration = windDurationNumber.toFixed(2) + 's';
    var markup = '';

    /* A0. 原始动态渐变矢量流场：尾部全透明、头部半透明，速度决定周期。 */
    markup += '<defs>';
    markup += '<clipPath id="radar-disc-clip"><circle cx="' + centerX + '" cy="' + centerY + '" r="248" /></clipPath>';
    markup += '<linearGradient id="wind-trail-grad" x1="0%" y1="0%" x2="0%" y2="100%">';
    markup += '<stop offset="0%" stop-color="#ffffff" stop-opacity="0" />';
    markup += '<stop offset="45%" stop-color="#ffffff" stop-opacity="0.04" />';
    markup += '<stop offset="80%" stop-color="#ffffff" stop-opacity="0.12" />';
    markup += '<stop offset="100%" stop-color="#ffffff" stop-opacity="0.22" />';
    markup += '</linearGradient>';
    markup += '<linearGradient id="wind-trail-grad-fine" x1="0%" y1="0%" x2="0%" y2="100%">';
    markup += '<stop offset="0%" stop-color="#ffffff" stop-opacity="0" />';
    markup += '<stop offset="50%" stop-color="#ffffff" stop-opacity="0.03" />';
    markup += '<stop offset="85%" stop-color="#ffffff" stop-opacity="0.08" />';
    markup += '<stop offset="100%" stop-color="#ffffff" stop-opacity="0.15" />';
    markup += '</linearGradient>';
    markup += '<linearGradient id="wind-trail-grad-accent" x1="0%" y1="0%" x2="0%" y2="100%">';
    markup += '<stop offset="0%" stop-color="#e2f0ff" stop-opacity="0" />';
    markup += '<stop offset="40%" stop-color="#e2f0ff" stop-opacity="0.06" />';
    markup += '<stop offset="80%" stop-color="#e2f0ff" stop-opacity="0.16" />';
    markup += '<stop offset="100%" stop-color="#e2f0ff" stop-opacity="0.28" />';
    markup += '</linearGradient>';
    markup += '</defs>';

    var rotation = flowHeading - 180;
    markup += '<g class="radar-wind-flow" clip-path="url(#radar-disc-clip)" transform="rotate(' + rotation.toFixed(1) + ' ' + centerX + ' ' + centerY + ')">';
    [-180, -108, -36, 36, 108, 180].forEach(function (trackOffset, trackIndex) {
      var lineX = centerX + trackOffset;
      var accent = trackIndex === 2 || trackIndex === 3;
      var fine = trackIndex === 0 || trackIndex === 5;
      var trailLength = accent ? 52 : (fine ? 38 : 46);
      var gradient = accent ? 'url(#wind-trail-grad-accent)' : (fine ? 'url(#wind-trail-grad-fine)' : 'url(#wind-trail-grad)');
      var className = accent ? 'radar-wind-trail trail-accent' : 'radar-wind-trail';
      var baseDelay = -0.5 * trackIndex - 0.2 * (trackIndex % 2);

      function addParticle(delay) {
        markup += '<g class="radar-wind-particle">';
        markup += '<animateTransform attributeName="transform" type="translate" from="0 -290" to="0 290" dur="' + windDuration + '" repeatCount="indefinite" begin="' + delay.toFixed(2) + 's" />';
        markup += '<path d="M ' + lineX.toFixed(1) + ' ' + (centerY - trailLength) + ' L ' + (lineX + 1.2).toFixed(1) + ' ' + (centerY - 2) + ' A 1.2 1.2 0 0 1 ' + (lineX - 1.2).toFixed(1) + ' ' + (centerY - 2) + ' Z" fill="' + gradient + '" class="' + className + '" />';
        markup += '</g>';
      }
      addParticle(baseDelay);
      addParticle(baseDelay - windDurationNumber * 0.5);
    });
    markup += '</g>';

    /* A. 原始网格、坐标点、方位与刻度。 */
    RADAR_DISTS.forEach(function (distance) {
      markup += '<circle cx="' + centerX + '" cy="' + centerY + '" r="' + RADAR_RADII[distance] + '" class="radar-grid-ring" />';
    });
    RADAR_DIRS.forEach(function (direction) {
      var angle = direction.az * Math.PI / 180;
      var endX = centerX + 248 * Math.sin(angle);
      var endY = centerY - 248 * Math.cos(angle);
      markup += '<line x1="' + centerX + '" y1="' + centerY + '" x2="' + endX.toFixed(1) + '" y2="' + endY.toFixed(1) + '" class="radar-grid-axis" />';
    });
    markup += '<line x1="' + (centerX - 6) + '" y1="' + centerY + '" x2="' + (centerX + 6) + '" y2="' + centerY + '" stroke="rgba(255,255,255,0.28)" stroke-width="1.2" />';
    markup += '<line x1="' + centerX + '" y1="' + (centerY - 6) + '" x2="' + centerX + '" y2="' + (centerY + 6) + '" stroke="rgba(255,255,255,0.28)" stroke-width="1.2" />';
    RADAR_DIRS.forEach(function (direction) {
      var angle = direction.az * Math.PI / 180;
      var labelX = centerX + 280 * Math.sin(angle);
      var labelY = centerY - 280 * Math.cos(angle);
      markup += '<text x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" class="radar-dir-label">' + direction.dir + '</text>';
    });
    var distanceLabelAngle = 22.5 * Math.PI / 180;
    RADAR_DISTS.forEach(function (distance) {
      var radius = RADAR_RADII[distance];
      var textX = centerX + radius * Math.sin(distanceLabelAngle);
      var textY = centerY - radius * Math.cos(distanceLabelAngle);
      markup += '<text x="' + textX.toFixed(1) + '" y="' + (textY - 4).toFixed(1) + '" class="radar-dist-label">' + distance + 'km</text>';
    });
    if (result.sunset_azimuth != null) {
      var sunsetAzimuth = result.sunset_azimuth;
      var sunsetAngle = sunsetAzimuth * Math.PI / 180;
      var sunsetX = centerX + 258 * Math.sin(sunsetAngle);
      var sunsetY = centerY - 258 * Math.cos(sunsetAngle);
      markup += '<line x1="' + centerX + '" y1="' + centerY + '" x2="' + sunsetX.toFixed(1) + '" y2="' + sunsetY.toFixed(1) + '" class="radar-sunset-ray" />';
      var badgeX = centerX + 195 * Math.sin(sunsetAngle);
      var badgeY = centerY - 195 * Math.cos(sunsetAngle);
      var badgeText = '🌅 日落 ' + Math.round(sunsetAzimuth) + '°';
      markup += '<g class="radar-sunset-badge-group">';
      markup += '<text x="' + badgeX.toFixed(1) + '" y="' + (badgeY + 5).toFixed(1) + '" class="radar-sunset-badge-shadow">' + badgeText + '</text>';
      markup += '<text x="' + badgeX.toFixed(1) + '" y="' + (badgeY + 5).toFixed(1) + '" class="radar-sunset-badge">' + badgeText + '</text>';
      markup += '</g>';
    }

    /* A2. 总云量底色（扇区越亮云越多）与无数据节点的空心标记。 */
    allPoints.forEach(function (point) {
      if (!point.hasData) {
        markup += '<circle cx="' + point.x + '" cy="' + point.y + '" r="6" class="radar-node-missing" />';
      } else if (point.slot && point.total > 0) {
        var path = cellPath(point);
        if (path) markup += '<path d="' + path + '" class="radar-cloud-cell" fill-opacity="' + (0.03 + 0.25 * point.total / 100).toFixed(3) + '" />';
      }
    });

    /* B. 原始绘制顺序：低云 -> 中云 -> 高云，自底向上叠色。 */
    function addLayer(layer, className) {
      if (!radarVisibleLayers[layer]) return;
      allPoints.forEach(function (point) {
        if (!point.hasData) return;
        var radius = calculateRadius(point[layer]);
        if (radius > 0) markup += '<circle cx="' + point.x + '" cy="' + point.y + '" r="' + radius.toFixed(1) + '" class="radar-cloud-circle ' + className + '" />';
      });
    }
    addLayer('low', 'radar-cloud-low');
    addLayer('mid', 'radar-cloud-mid');
    addLayer('high', 'radar-cloud-high');

    /* C. 原始 24px Hitbox 和中心微光标点。 */
    allPoints.forEach(function (point, pointIndex) {
      markup += '<g class="radar-node-target" data-idx="' + pointIndex + '">';
      markup += '<circle cx="' + point.x + '" cy="' + point.y + '" r="24" fill="transparent" />';
      markup += '<circle cx="' + point.x + '" cy="' + point.y + '" r="2.8" fill="rgba(255,255,255,0.45)" class="radar-hover-indicator" stroke="transparent" />';
      markup += '</g>';
    });
    chart.innerHTML = markup;

    var targets = chart.querySelectorAll('.radar-node-target');
    var container = chart.closest('.radar-chart-container');
    function showTooltip(event, point) {
      if (!tooltip || !container) return;
      var rect = container.getBoundingClientRect();
      var clientX = event.clientX || (event.touches && event.touches[0] ? event.touches[0].clientX : 0);
      var clientY = event.clientY || (event.touches && event.touches[0] ? event.touches[0].clientY : 0);
      var positionX = clientX - rect.left;
      var positionY = clientY - rect.top;
      var lowStyle = radarVisibleLayers.low ? 'color:#85a5ff' : 'color:rgba(133,165,255,0.4);text-decoration:line-through';
      var midStyle = radarVisibleLayers.mid ? 'color:#95de64' : 'color:rgba(149,222,100,0.4);text-decoration:line-through';
      var highStyle = radarVisibleLayers.high ? 'color:#ffc069' : 'color:rgba(255,192,105,0.4);text-decoration:line-through';
      tooltip.innerHTML = !point.hasData
        ? '<div class="radar-tooltip-title">' + point.label + '</div><div class="radar-tooltip-row"><span>暂无数据（不代表无云）</span></div>'
        : '<div class="radar-tooltip-title">' + point.label + '</div>' +
        '<div class="radar-tooltip-row"><span>总云量:</span><strong>' + point.total + '%</strong></div>' +
        '<div class="radar-tooltip-row" style="' + lowStyle + '"><span>低云 (LOW):</span><span>' + point.low + '%' + (!radarVisibleLayers.low ? ' (隐藏)' : '') + '</span></div>' +
        '<div class="radar-tooltip-row" style="' + midStyle + '"><span>中云 (MID):</span><span>' + point.mid + '%' + (!radarVisibleLayers.mid ? ' (隐藏)' : '') + '</span></div>' +
        '<div class="radar-tooltip-row" style="' + highStyle + '"><span>高云 (HIGH):</span><span>' + point.high + '%' + (!radarVisibleLayers.high ? ' (隐藏)' : '') + '</span></div>';
      tooltip.style.left = Math.max(60, Math.min(rect.width - 60, positionX)) + 'px';
      tooltip.style.top = Math.max(40, positionY - 10) + 'px';
      tooltip.classList.remove('hidden');
    }
    function hideTooltip() { if (tooltip) tooltip.classList.add('hidden'); }
    targets.forEach(function (element) {
      var index = parseInt(element.getAttribute('data-idx'), 10);
      var point = allPoints[index];
      if (!point) return;
      element.addEventListener('mouseenter', function (event) { showTooltip(event, point); });
      element.addEventListener('mousemove', function (event) { showTooltip(event, point); });
      element.addEventListener('mouseleave', hideTooltip);
      element.addEventListener('click', function (event) { event.stopPropagation(); showTooltip(event, point); });
      element.addEventListener('touchstart', function (event) { event.stopPropagation(); showTooltip(event, point); }, { passive: false });
    });
    if (container) container.addEventListener('mouseleave', hideTooltip);
    if (!root._radarGlobalDismissBound) {
      function handleGlobalTouchOrClick(event) {
        var currentTooltip = $('radar-tooltip');
        if (currentTooltip && !currentTooltip.classList.contains('hidden')) {
          if (!event.target.closest || (!event.target.closest('.radar-node-target') && !event.target.closest('#radar-tooltip'))) {
            currentTooltip.classList.add('hidden');
          }
        }
      }
      root.document.addEventListener('touchstart', handleGlobalTouchOrClick, { passive: true });
      root.document.addEventListener('click', handleGlobalTouchOrClick);
      root._radarGlobalDismissBound = true;
    }
  }

  SS.radarView = {
    render: renderCloudFieldRadar,
    buildModel: buildRadarModel,
    cloudRadius: cloudRadius,
    radiusForDistance: radiusForDistance,
    cellPath: cellPath,
    visibleLayers: radarVisibleLayers
  };
})(typeof window !== 'undefined' ? window : globalThis);
