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

    var centerX = 310, centerY = 310;
    var maxCloudRadius = 23.5;
    var centerNode = cloudField.center || {};
    var centerData = centerNode.data || {};
    var allPoints = [{
      key: 'CENTER_0', label: '本地中心 (0km)', azimuth: 0, distanceKm: 0,
      x: centerX, y: centerY,
      low: centerData.cloud_cover_low || 0,
      mid: centerData.cloud_cover_mid || 0,
      high: centerData.cloud_cover_high || 0,
      total: centerData.cloud_cover || 0
    }];

    RADAR_DIRS.forEach(function (direction) {
      var angle = direction.az * Math.PI / 180;
      RADAR_DISTS.forEach(function (distance) {
        var ringRadius = RADAR_RADII[distance] || 248;
        var key = direction.dir + '_' + distance;
        var record = cloudField.nodeMap && cloudField.nodeMap[key];
        if (!record && cloudField.nodes) {
          for (var i = 0; i < cloudField.nodes.length; i++) {
            if (cloudField.nodes[i].direction === direction.dir && cloudField.nodes[i].distanceKm === distance) {
              record = cloudField.nodes[i];
              break;
            }
          }
        }
        var data = record && record.data || {};
        allPoints.push({
          key: key,
          label: direction.label + ' · ' + distance + 'km',
          azimuth: direction.az,
          distanceKm: distance,
          x: Math.round((centerX + ringRadius * Math.sin(angle)) * 10) / 10,
          y: Math.round((centerY - ringRadius * Math.cos(angle)) * 10) / 10,
          low: data.cloud_cover_low || 0,
          mid: data.cloud_cover_mid || 0,
          high: data.cloud_cover_high || 0,
          total: data.cloud_cover || 0
        });
      });
    });

    /* V2.2.2 原始线性半径映射：0% 不绘制，>0% 为 3.2~23.5px。 */
    function calculateRadius(percent) {
      if (!percent || percent <= 0) return 0;
      return Math.max(3.2, percent / 100 * maxCloudRadius);
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

    /* B. 原始绘制顺序：低云 -> 中云 -> 高云，自底向上叠色。 */
    function addLayer(layer, className) {
      if (!radarVisibleLayers[layer]) return;
      allPoints.forEach(function (point) {
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
      tooltip.innerHTML =
        '<div class="radar-tooltip-title">' + point.label + '</div>' +
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
    visibleLayers: radarVisibleLayers
  };
})(typeof window !== 'undefined' ? window : globalThis);
