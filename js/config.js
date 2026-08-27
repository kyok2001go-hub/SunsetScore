/* ============================================================
 * SunsetScore V2.3.1 - 当前生产参数配置
 * 所有参数均为初始经验值 [TUNE]，未来可根据真实观测数据校准
 * V1.6：新增 Spatial Cloud Field 空间语义参数（SPATIAL_FIELD_V16）
 * V1.61：新增空间演化能力参数（SPATIAL_FIELD_V161）
 * V1.7：新增 Weather Regime 动态权重参数（WEATHER_REGIME_V17）
 * V1.8：新增自适应采样与缓存参数（SPATIAL_API_V18）
 * V1.9：新增 Nowcasting 临近预报参数（NOWCAST_V19）
 * V2.0：新增天空演化概率预测参数（EVOLUTION_V20）
 * V2.1：全天空云场演化与风场驱动预测系统（立体33点采样）
 * V2.1.1：全天空云场分布33点立体雷达图与动态风场矢量流场可视化
 * V2.1.2：移动端高屏占比布局与全天空雷达图交互优化
 * V2.2.0：基线参考模型对照、Cloudflare D1 实况反馈与全维度元数据闭环
 * V2.2.1：实况反馈悬浮弹窗交互、30分钟防刷限频与体验优化
 * V2.2.2：页面底部安全留白优化、实况备注输入框与全系统升级
 * ============================================================ */
(function (root) {
  'use strict';
  root.SunsetScore = root.SunsetScore || {};

  root.SunsetScore.version = Object.freeze({
    app: '2.3.1',
    model: '2.3.1',
    schema: 3,
    cache: 'v231',
    feedbackSchema: 2
  });

  root.SunsetScore.config = {
    version: root.SunsetScore.version.model,

    /* ---------- 空间云场采样（第 8 章） ---------- */
    distancesKm: [50, 100, 200, 300],
    azimuthOffsets: [-30, 0, 30],

    /* 地平线距离权重（第 10 章） */
    horizonDistanceWeights: { 0: 0.30, 50: 0.25, 100: 0.20, 200: 0.15, 300: 0.10 },

    /* 空间受光距离带权重（第 12.3 节） */
    illumBandWeights: [
      { maxKm: 50, weight: 0.20 },
      { maxKm: 100, weight: 0.25 },
      { maxKm: 200, weight: 0.30 },
      { maxKm: 300, weight: 0.25 }
    ],

    /* ---------- Sky Canvas（第 9 章） ---------- */
    highCloudCenter: 60,   /* [TUNE] 高云最佳中心 */
    highCloudWidth: 25,
    midCloudCenter: 40,    /* [TUNE] 中云最佳中心 */
    midCloudWidth: 25,
    canvasWeights: { high: 0.55, mid: 0.35, low: 0.10 },
    /* V1.5 旧版权重，V1.6 起由 skyCanvasWeightsV16 取代，保留以便回退对照 */
    skyCanvasWeights: { canvas: 0.55, far: 0.30, localCompat: 0.15 },
    farCloudMinKm: 100,    /* 远方云场起始距离 */

    /* ---------- V1.6 Spatial Cloud Field（升级方案 二~八 章） ---------- */
    spatialFieldV16: {
      corridorAngle: 15,        /* 日落走廊半宽（度） */
      bankAngle: 45,            /* 云幕区外缘（度） */
      angularPower: 2,          /* 角权重 W = cos(offset)^power */
      /* 分区权重：0°→走廊，±30°→云幕区；Side Sky 暂无采样点，
         计算时按可用分区重新归一（方案 3.2 节） */
      sectorWeights: { corridor: 0.6, bank: 0.3, side: 0.1 },
      /* 距离半开区间分带：[0,50) near / [50,100) medium / [100,200) far / [200,300] veryFar */
      distanceBands: { near: 0.15, medium: 0.25, far: 0.35, veryFar: 0.25 },
      /* 分带预报可信度：距离越远预报误差越大（方案 2.2 节） */
      forecastConfidence: { near: 1.0, medium: 0.9, far: 0.75, veryFar: 0.6 },
      /* 远方云幕价值系数（方案 5.3 节 DistanceBonus） */
      distanceBonus: { 50: 0.2, 100: 0.4, 200: 0.8, 300: 1.0 },
      /* Cloud Bank 云幕识别模型（方案 5 章） */
      cloudBank: {
        centerWeight: 0.5,
        contrastWeight: 0.3,
        distanceWeight: 0.2,
        contrastFull: 70,       /* 中心超出两侧该值时对比奖励封顶 */
        contrastBonusMax: 20,   /* 对比奖励上限（文档示例：contrast=70 → +20） */
        continuityStdScale: 1.5 /* [TUNE] 连续性：stdDev 反向映射系数 */
      },
      /* SkyCanvas V1.6 权重，V1.61 起由 skyCanvasWeightsV161 取代，保留以便回退对照 */
      skyCanvasWeightsV16: { local: 0.35, bank: 0.35, far: 0.20, continuity: 0.10 }
    },

    /* ---------- V1.61 Spatial Cloud Field 增强（增强方案 四~八 章） ---------- */
    spatialFieldV161: {
      /* Cloud Continuity：沿距离链的相邻相似度（方案 4.2 节） */
      continuity: { midWeight: 0.4, highWeight: 0.6 },
      /* Spatial Gradient：远/近程合成权重与 type 判定阈值 [TUNE]（方案 4.3 节） */
      gradient: { farDistanceWeight: 0.6, nearDistanceWeight: 0.4, farType: 20, nearType: -20 },
      /* CloudStructureScore 与远方连续云幕加分（方案 4.4 节） */
      structure: {
        continuityWeight: 0.6,
        gradientWeight: 0.4,
        bonusGradientMin: 30,
        bonusContinuityMin: 70,
        bonusValue: 5
      },
      /* Spatial Clearing Front（方案五章） */
      clearing: {
        historyHours: 3,
        strongThreshold: 70,   /* ClearingScore 超过该值升级 RAIN_TO_CLEAR_STRONG */
        strongBonus: 8,        /* STRONG 额外加分，仅 V1.7 回退路径使用 */
        directionGap: 10,      /* [TUNE] 远/近清空率差值超过该值才判定方向 */
        weights: { time: 0.5, spatial: 0.3, corridor: 0.2 }
      },
      /* Anti-Sunset Cloud：最小采样方案，复用本地节点近似（方案六章） */
      antiSunset: {
        enabled: true,
        skyCanvasWeight: 0.10,
        weights: { high: 0.5, continuity: 0.3, visibility: 0.2 }
      },
      /* SkyCanvas V1.61 权重（方案 6.5 节） */
      skyCanvasWeightsV161: { local: 0.30, bank: 0.30, far: 0.15, structure: 0.15, antiSunset: 0.10 }
    },

    /* ---------- Horizon Gate（第 11 章） ---------- */
    horizonGate: [
      { min: 80, gate: 1.00 },
      { min: 60, gate: 0.90 },
      { min: 40, gate: 0.75 },
      { min: 20, gate: 0.50 },
      { min: 0, gate: 0.25 }
    ],

    /* ---------- Atmosphere（第 13 章） ---------- */
    atmosphereWeights: { visibility: 0.35, aod: 0.30, pm25: 0.20, humidity: 0.15 },
    aodCenter: 0.25,       /* [TUNE] AOD 最佳中心 */
    aodWidth: 0.18,
    humidityCenter: 55,
    humidityWidth: 30,
    visibilityScaleKm: 8,  /* 能见度评分饱和速度 */

    /* ---------- Weather Regime（第 14-16 章） ---------- */
    regimeScore: {
      CLEAR: 70,
      PARTLY_CLOUDY: 80,
      RAIN_TO_CLEAR: 90,
      FRONT_PASSING: 75,
      OVERCAST: 25,
      HAZY: 40,
      STORM_APPROACHING: 15
    },
    regimeLabels: {
      CLEAR: '晴朗',
      PARTLY_CLOUDY: '多云间晴',
      RAIN_TO_CLEAR: '雨后转晴',
      FRONT_PASSING: '锋面过境',
      OVERCAST: '阴天',
      HAZY: '雾霾',
      STORM_APPROACHING: '风暴逼近'
    },
    /* V1.7 起天气型不再直接加分；仅在 weatherRegimeV17.enabled=false 回退路径使用 */
    regimeBonus: { RAIN_TO_CLEAR: 8, FRONT_PASSING: 3 }, /* [TUNE] +5~+10 */
    rainToClearLookbackHours: 4,
    rainToClearMinRainMm: 0.3,                     /* [TUNE] 判定"存在明显降雨"的小时雨量阈值 */
    rainToClearLowCloudLeadHours: 2,               /* 低云减少趋势的对比提前量（小时） */
    rainToClearLowCloudDrop: 5,                    /* [TUNE] 扇区低云均值需下降的百分点 */
    rainToClearGoldenWindow: { min: 30, max: 90 }, /* [TUNE] 第 15 章黄金窗口：降雨结束后 30–90 分钟 */

    /* ---------- V1.7 Weather Regime 动态权重（技术方案 五~十五 章） ---------- */
    weatherRegimeV17: {
      enabled: true,              /* A/B 开关：false 时走 V1.61 原公式 */
      transitionEnabled: true,
      /* 各 Regime 权重乘数（技术方案九章）：
         FinalWeight = BaseWeight × 乘数（按 strength 插值），Weather 权重取下限后整体归一。
         HAZY 为文档缺项补充 [TUNE]：雾霾天主要信任大气透明度 */
      weights: {
        CLEAR:             { skyCanvas: 1.2, horizon: 1.1, illumination: 1.1, atmosphere: 1.3, weather: 0.5 },
        PARTLY_CLOUDY:     { skyCanvas: 1.3, horizon: 1.2, illumination: 1.2, atmosphere: 1.0, weather: 0.8 },
        RAIN_TO_CLEAR:     { skyCanvas: 1.5, horizon: 1.4, illumination: 1.3, atmosphere: 0.8, weather: 1.2 },
        FRONT_PASSING:     { skyCanvas: 1.1, horizon: 1.3, illumination: 1.2, atmosphere: 0.8, weather: 1.5 },
        OVERCAST:          { skyCanvas: 0.7, horizon: 1.5, illumination: 0.8, atmosphere: 0.7, weather: 1.3 },
        STORM_APPROACHING: { skyCanvas: 0.5, horizon: 1.5, illumination: 0.5, atmosphere: 0.5, weather: 2.0 },
        HAZY:              { skyCanvas: 0.8, horizon: 1.0, illumination: 0.8, atmosphere: 1.5, weather: 0.9 }
      },
      /* RAIN_TO_CLEAR 强度公式（方案 6.2 节）：
         0.30 RainHistory + 0.30 ClearingFront + 0.20 OpeningTrend + 0.20 CloudStructure */
      rainToClearStrength: { history: 0.30, clearingFront: 0.30, openingTrend: 0.20, cloudStructure: 0.20 },
      rainHistoryFullMm: 4,        /* [TUNE] 过去降雨量达到该值时 RainHistory 项记满 */
      strongStrengthBoost: 0.15,   /* ClearingScore 超过 strongThreshold 时额外提升的强度 */
      /* WeatherScore 组成（方案十二章） */
      weatherScore: { current: 0.4, trend: 0.3, stability: 0.3, stabilityHours: 2 },
      /* Regime Transition（方案十章） */
      transitionLookbackHours: 2,  /* 过去对比点：日落前 N 小时 */
      transitionLeadHours: 1,      /* 未来对比点：日落后 N 小时 */
      transitionBonusPerStep: 1,   /* 每档"晴朗进度"差值对应的过渡加分 */
      transitionBonusLimit: 5,
      minimumWeatherWeight: 0.05   /* Weather 动态权重下限 */
    },

    /* ---------- Penalty / Hard Gate（第 16-17 章） ---------- */
    penalty: { rain: [15, 35], storm: [15, 30], haze: [5, 20] },
    hardGate: { horizonOpeningPct: 10, visibilityKm: 2, scoreCap: 15 },

    /* ---------- 最终公式（第 18 章） ---------- */
    weights: { skyCanvas: 0.30, horizon: 0.20, illumination: 0.20, atmosphere: 0.20, weather: 0.10 },
    atmosphereQuality: { base: 0.70, scale: 0.30 },

    /* ---------- 晚霞等级（第 19 章） ---------- */
    levels: [
      { min: 90, label: '极佳' },
      { min: 75, label: '很好' },
      { min: 60, label: '不错' },
      { min: 40, label: '一般' },
      { min: 20, label: '较差' },
      { min: 0, label: '很差' }
    ],

    /* ---------- 最佳观赏窗口 ---------- */
    viewingWindow: { startOffsetMin: -25, peakOffsetMin: 5, endAfterCivilDuskMin: 5 },

    /* ---------- 缓存（第 28 章） ---------- */
    cacheTtlMinutes: 15,
    cachePrefix: 'sunsetscore_' + root.SunsetScore.version.cache + '_',

    /* ---------- V1.8 自适应采样（技术方案 7-9、17、20 章） ---------- */
    samplingV18: {
      enabled: true,
      /* [TUNE] STANDARD 模式 7 点选型：Local + 走廊全距离 + ±30° 云幕各 1 点。
         选型理由：走廊分区权重 0.6 最高，且完整覆盖地平线距离权重表 4 档 */
      standardCorridorDistancesKm: [50, 100, 200, 300],
      standardBankDistancesKm: [100],
      /* 节点重要性权重（供加权完整度，方案 17 章）：核心节点高、远场低 */
      nodeWeights: { local: 1.0, corridor: 0.9, bank: 0.6 },
      /* Smart Escalation（方案 8-9 章）：STANDARD 初算后满足任一条件即升级 13 点 */
      escalation: {
        maxEscalation: 1,
        scoreConfidenceThreshold: 65,   /* [TUNE] 置信度低于该值升级（0-100） */
        spatialVarianceThreshold: 25,   /* [TUNE] 低云 stdDev 超过该值升级 */
        transitionScoreThreshold: 30    /* [TUNE] IMPROVING 过渡评分超过该值升级 */
      },
      /* LOCAL_ONLY 直判（方案 8.3 节）：浓厚阴天时空间采样价值低 */
      localOnly: { cloudCoverMin: 90, visibilityMaxKm: 5, precipitationMinMm: 0.3 },
      /* 批量请求失败：指数退避重试（方案 14.1 节） */
      batchRetry: { maxAttempts: 2, baseDelayMs: 1500, backoffFactor: 2 }
    },

    /* ---------- V1.8 缓存策略（方案 10-11、15 章） ---------- */
    cacheV18: {
      ttlGeocodingDays: 7,
      ttlSolarHours: 24,
      ttlForecastMinutes: 60,           /* 临近日落时缩短 */
      ttlForecastWithin6h: 30,
      ttlForecastWithin3h: 15,
      ttlAirQualityMinutes: 120,
      staleMaxAgeHours: 24              /* 过期缓存（STALE）可回退使用的最长时限 */
    },

    /* ---------- V1.8 预报时间窗口（方案 12 章） ---------- */
    /* 实际裁剪窗口 = [min(日落-6h, 当前-8h), max(日落+1h, 当前+2h)]，
       向当前时刻额外延伸，保证 Regime/Clearing 等回看特征有足够历史小时 */
    forecastWindowV18: { lookbackHours: 6, lookaheadHours: 1, nowLookbackHours: 8, nowLookaheadHours: 2 },

    /* ---------- V1.9 Nowcasting 临近预报（技术方案 Phase 1-3） ---------- */
    nowcastV19: {
      enabled: true,
      /* 融合权重（方案 8 章）：缺失源自动重归一到可用源 */
      weights: { forecast: 0.40, precip: 0.20, radar: 0.25, satellite: 0.15 },
      /* 雨停评分表（方案 4.4 节） */
      rainClear: {
        stopWithin30: 20, stopWithin60: 10,
        persisting: -30, intensifying: -40,
        dryThresholdMm: 0.1,     /* [TUNE] 视为无雨的降水上限（mm） */
        dryStreakMinutes: 20     /* [TUNE] 连续无雨多久（分钟）才判定雨停 */
      },
      /* goldenWindowModifier 限幅与临近门控（方案 4.5 节）：
         距日落 ≤fullGateHours 全量生效，到 fadeEndHours 线性衰减为 0 */
      modifierLimit: 30,
      proximityGate: { fullGateHours: 2, fadeEndHours: 4, fetchLimitHours: 4 },
      /* 雷达源：RainViewer Weather Maps API（免费公开接口，无需注册与密钥）。
         双帧雷达瓦片 → 日落走廊回波覆盖率 / 质心运动 / 到达风险。
         注意：v2 API 最大 zoom=7；帧间隔 10 分钟，past 保留 2 小时 */
      radar: {
        endpoint: 'https://api.rainviewer.com/public/weather-maps.json',
        tileSize: 256,
        zoom: 7,
        coverRadiusKm: 340,
        echoAlphaThreshold: 30,  /* [TUNE] 瓦片像素 alpha 超过该值视为回波 */
        arrivalHorizonMin: 120,
        riskThresholds: { high: 30, medium: 90 }, /* 雨团预计进入走廊分钟数 → High/Medium/Low */
        /* 旧端点备查：v1.json 已下线返回 404 */
        legacyEndpointV1: 'https://api.rainviewer.com/v1.json'
      },
      /* 卫星（NASA GIBS，Phase 3）：图层名随 GIBS 产品调整，按候选列表探测可用性，
         全部不可用时该源静默降级（V1.9.1：True Color 系列已下线） */
      satellite: {
        capabilities: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml',
        tileBase: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best',
        layers: {
          himawari: {
            candidates: ['Himawari_AHI_Band3_Red_Visible_1km', 'Himawari_AHI_True_Color'],
            lonMin: 50, lonMax: 200
          },
          goesEast: {
            candidates: ['GOES-East_ABI_Band2_Red_Visible_1km', 'GOES-East_ABI_True_Color'],
            lonMin: -105, lonMax: 50
          },
          goesWest: {
            candidates: ['GOES-West_ABI_Band2_Red_Visible_1km', 'GOES-West_ABI_True_Color'],
            lonMin: -180, lonMax: -105
          }
        },
        tileSize: 256, zoom: 4,
        coverRadiusKm: 600,
        cloudLumThreshold: 200,   /* [TUNE] 亮度高于该值且低饱和度视为云 */
        cloudSatMax: 40,
        highCloudCenter: 45,      /* [TUNE] 走廊云覆盖率最佳中心（近似薄高云带） */
        highCloudWidth: 25,
        arrivalHorizonMin: 60
      },
      /* 缓存 TTL（分钟，方案 9 章） */
      ttlMinutes: { precip: 10, radar: 10, satellite: 15 },
      /* QWeather 分钟级降水（Phase 1 首选数据源，覆盖中国区）：
         浏览器只调用同源 /api/qweather，不保存 API Key。
         Cloudflare Pages Function 从 QWEATHER_API_KEY Secret 读取；本地 npm run dev
         则由开发服务器读取根目录 QweatherKey.txt。请求失败时回退 Open-Meteo。 */
      qweather: {
        host: 'nn33jrmyy9.re.qweatherapi.com',
        endpoint: '/api/qweather'
      }
    },

    /* ---------- V2.0 天空演化概率预测（技术方案 5-12 章） ---------- */
    evolutionV20: {
      enabled: true,
      /* 日落走廊（方案 5 章）：方位 ±30°、距离 0~250km、时间窗 0~120 分钟 */
      corridor: { azimuthHalfWidth: 30, maxDistanceKm: 250 },
      /* 开放概率模型（方案 6.3 章）：FutureCoverage = C0·e^(−kt)，
         P_open = logistic(阈值 − FC(t), σ(t))，σ(t)=σ0+γ·t 随时间增大 */
      openCoverageThreshold: 20,  /* [TUNE] 覆盖率低于该值认为走廊开放 */
      sigma0: 8,                  /* [TUNE] 基础不确定度（%） */
      sigmaPerMin: 0.15,          /* [TUNE] 不确定度随预测时距线性增长 */
      probClamp: [0.02, 0.98],
      /* 融合权重（方案 12 章权重表解释为演化引擎内部权重） */
      fusionWeights: { background: 0.30, precip: 0.20, radar: 0.25, satellite: 0.15, observation: 0.10 },
      /* QWeather 雨停置信度曲线（方案 7 章） */
      rainStopConfidence: { noInfo: 0.5, persisting: 0.3, intensifying: 0.1, marginWidthMin: 10 },
      /* 状态机（方案 9 章，全部 [TUNE]） */
      stateMachine: {
        openCoverageMax: 20, openProb60Min: 0.6,
        blockedCoverageMin: 80, blockedProb60Max: 0.3,
        trendEpsilon: 0.1,          /* 趋势判定阈值（%/min） */
        maxSigma60: 40              /* σ(60) 归一化上限（%） */
      },
      /* Golden Window V3（方案 10 章）：Score × (floor + (1−floor) × P_open) */
      gwFactor: { floor: 0.5 },
      evolutionTtlMinutes: 10,
      /* 卫星云覆盖风险阈值：覆盖率超过该值视为云层遮挡太阳区域（方案 8.3） */
      cloudCoverRiskThreshold: 60,
      satelliteOpenThreshold: 25   /* [TUNE] 卫星覆盖率低于该值认为开放 */
    },

    /* ---------- V2.1 全天空 360° 云场引擎（技术方案 第 4 章） ---------- */
    cloudFieldV21: {
      enabled: true,
      /* 8 方位与方位角（0°=北，顺时针） */
      directions: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
      azimuths: [0, 45, 90, 135, 180, 225, 270, 315],
      /* 4 距离带（km） */
      distancesKm: [50, 100, 200, 300],
      /* 3 高度层 */
      levels: ['LOW', 'MID', 'HIGH'],
      /* 云层浓厚/遮挡阈值（%） */
      denseCloudThreshold: 70,
      clearCloudThreshold: 20
    },

    /* ---------- V2.1 风场驱动云平流运动模型（技术方案 第 5 章） ---------- */
    windMotionV21: {
      enabled: true,
      /* 预测时距（分钟） */
      forecastHorizonsMin: [30, 60, 120],
      /* 大气边界层（ABL）分层动力学切变与地转偏转配置（回退与参考） */
      stratifiedLayers: {
        low:  { multiplier: 1.8, minSpeedKmH: 8.0,  veeringDeg: 15 },
        mid:  { multiplier: 2.5, minSpeedKmH: 18.0, veeringDeg: 30 },
        high: { multiplier: 4.0, minSpeedKmH: 35.0, veeringDeg: 45 }
      },
      /* 兼容保留 */
      upperWindSpeedMultiplier: { low: 1.8, mid: 2.5, high: 4.0 },
      /* 上游到达风险判定参数 */
      arrivalRisk: {
        upstreamSectorHalfWidthDeg: 35,
        denseCloudCoverMin: 65,
        /* 风险衰减/扩散系数 */
        dispersionPer100Km: 0.10,
        /* 日落演化有效到达时效上限（分钟）：超过该时限的远方云团不计入今日落即时威胁 */
        maxArrivalHorizonMin: 180
      }
    },

    /* ---------- V2.1 全天天空状态机与演化因子（技术方案 第 6、8 章） ---------- */
    skyStateV21: {
      enabled: true,
      states: ['CLEAR', 'OPENING', 'STABLE', 'CLOSING', 'CLOUD_ARRIVING', 'UNCERTAIN'],
      clearCloudMax: 25,
      openingDropRateMin: 5,        /* 每小时云量下降 5% 以上 */
      closingGrowthRateMin: 5,      /* 每小时云量上升 5% 以上 */
      cloudArrivingRiskThreshold: 0.35,
      /* 日落扇区加权：日落走廊 60%，反日落 25%，侧向 15% */
      sectorWeights: { corridor: 0.60, antiSunset: 0.25, side: 0.15 },
      corridorHalfWidthDeg: 45,
      antiSunsetHalfWidthDeg: 35,
      /* SkyEvolutionFactor 限幅区间 [0.65, 1.15] */
      factorRange: [0.65, 1.15]
    },

    /* ---------- V2.1 日落事件层与 Golden Window V4（技术方案 第 7、8 章） ---------- */
    goldenWindowV4: {
      enabled: true,
      activationWindowMin: 180,     /* 距日落 T-180m 内激活 */
      baseFloor: 0.50
    },

    /* ---------- API 端点 ---------- */
    endpoints: {
      geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
      forecast: 'https://api.open-meteo.com/v1/forecast',
      airQuality: 'https://air-quality-api.open-meteo.com/v1/air-quality'
    },
    hourlyVariables: [
      'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
      'visibility', 'relative_humidity_2m', 'precipitation', 'precipitation_probability',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'surface_pressure',
      'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_700hPa', 'wind_direction_700hPa',
      'wind_speed_500hPa', 'wind_direction_500hPa'
    ].join(',')
  };
})(typeof window !== 'undefined' ? window : globalThis);
