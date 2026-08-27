-- ============================================================
-- SunsetScore V2.3.1 - Cloudflare D1 数据库完整全量结构定义
-- 包含：宏观天文、逐层微气象、NWP分层探空、天空演化时序、动态权重、原始快照
-- ============================================================

CREATE TABLE IF NOT EXISTS sunset_feedback (
    -- 1. 主键与时间戳
    id TEXT PRIMARY KEY,                           -- 记录唯一标识 (如 fb_1724567890_abcde)
    query_id TEXT NOT NULL,                       -- 对应单次查询快照唯一 ID (UUID)
    created_at TEXT NOT NULL,                     -- V2.2 兼容字段（北京时间文本）
    created_at_local TEXT,                        -- 观测点当地时间 (对应当地时区, YYYY-MM-DD HH:mm:ss)
    created_at_epoch INTEGER NOT NULL,             -- 唯一计算/排序/限频时间基准（UTC epoch ms）
    created_at_utc TEXT NOT NULL,                  -- UTC ISO-8601 审计字段
    
    -- 2. 地理与天文元数据
    city TEXT NOT NULL,                           -- 城市名
    country TEXT,                                 -- 国家/地区代码
    admin1 TEXT,                                  -- 省 / 州 / 行政一级
    latitude REAL NOT NULL,                       -- 观测点纬度
    longitude REAL NOT NULL,                      -- 观测点经度
    timezone TEXT,                                -- 当地时区 (如 Asia/Shanghai)
    sunset_time_local TEXT,                       -- 当地日落时间 (YYYY-MM-DD HH:mm)
    sunset_azimuth REAL,                          -- 日落方位角 (度)
    twilight_minutes INTEGER,                     -- 民用暮光持续时长 (分钟)
    best_viewing_window TEXT,                     -- 最佳观赏时间窗 (如 18:35 - 19:05)
    
    -- 3. 预测输出指标 (Model Predictions)
    app_version TEXT NOT NULL,                    -- 应用版本
    model_version TEXT NOT NULL,                  -- 模型版本
    schema_version INTEGER NOT NULL,              -- 领域/缓存 schema 版本
    predicted_score INTEGER NOT NULL,             -- 高级动力学预测总分 (0~100)
    predicted_level TEXT NOT NULL,                -- 预测等级 (极佳/好/一般/较差)
    baseline_score INTEGER,                       -- 极简基线模型得分 (0~100)
    baseline_level TEXT,                          -- 极简基线等级
    regime_label TEXT,                            -- 识别的天气型 (如 槽后清空型/弱受光型)
    regime_strength REAL,                         -- 天气型判别强度 (0.0~1.0)
    sky_evolution_state TEXT,                     -- 全天天况宏观演化态 (CLEAR/OPENING/STABLE...)
    sky_evolution_factor REAL,                    -- 宏观演化因子 (0.65~1.15)
    gw_factor REAL,                               -- 黄金窗口演化修正乘法因子 (0.70~1.05)
    
    -- 4. 核心物理特征向量 (Physical Feature Vector X)
    comp_sky_canvas INTEGER,                      -- 云幕结构得分
    comp_horizon INTEGER,                         -- 地平线通透得分
    comp_illumination INTEGER,                    -- 高空受光得分
    comp_atmosphere INTEGER,                      -- 大气质量得分
    comp_weather INTEGER,                         -- 天气风险得分
    cloud_cover_total INTEGER,                    -- 本地总云量 (%)
    cloud_cover_low INTEGER,                      -- 本地低云量 (%)
    cloud_cover_mid INTEGER,                      -- 本地中云量 (%)
    cloud_cover_high INTEGER,                     -- 本地高云量 (%)
    corridor_cloud_mid REAL,                      -- 走廊平均中云 (%)
    corridor_cloud_high REAL,                     -- 走廊平均高云 (%)
    anti_sunset_score INTEGER,                    -- 反日落东方反射得分
    spatial_variance REAL,                        -- 全天空云场离散度 (标准差)
    cloud_continuity INTEGER,                     -- 走廊云幕连续性指标 (0~100)
    
    -- 5. 环境与微气象物理量
    aod REAL,                                     -- 气溶胶光学厚度 (AOD 0.05~0.80)
    pm25 REAL,                                    -- PM2.5 质量浓度 (μg/m³)
    humidity REAL,                                -- 日落相对湿度 (%)
    surface_pressure REAL,                        -- 地面气压 (hPa)
    visibility_km REAL,                           -- 能见度 (km)
    precipitation REAL,                           -- 降水量 (mm)
    
    -- 6. 多层探空风场 (Sounding Winds)
    layer_wind_850_speed REAL,                    -- 850hPa 探空等压面风速 (km/h)
    layer_wind_850_dir REAL,                      -- 850hPa 探空等压面风向 (度)
    layer_wind_700_speed REAL,                    -- 700hPa 探空等压面风速 (km/h)
    layer_wind_700_dir REAL,                      -- 700hPa 探空等压面风向 (度)
    layer_wind_500_speed REAL,                    -- 500hPa 探空等压面风速 (km/h)
    layer_wind_500_dir REAL,                      -- 500hPa 探空等压面风向 (度)
    is_real_sounding INTEGER DEFAULT 1,           -- 是否为真实等压面探空 (1=真实, 0=经验切变)
    
    -- 7. 临近演化与侵入概率分布 (时序概率)
    open_prob_30m REAL,                           -- +30m 走廊开放概率 (0.0~1.0)
    open_prob_60m REAL,                           -- +60m 走廊开放概率 (0.0~1.0)
    open_prob_120m REAL,                          -- +120m 走廊开放概率 (0.0~1.0)
    arrival_risk_30m REAL,                        -- +30m 上游浓云侵入风险 (0.0~1.0)
    arrival_risk_60m REAL,                        -- +60m 上游浓云侵入风险 (0.0~1.0)
    tile_radar_available INTEGER DEFAULT 0,       -- 实况雷达瓦片是否有效接入 (1/0)
    tile_sat_available INTEGER DEFAULT 0,         -- 实况卫星云图是否有效接入 (1/0)
    
    -- 8. 动态权重分配 (Dynamic Weights)
    dyn_weight_canvas REAL,                       -- 云幕动态权重占比
    dyn_weight_horizon REAL,                      -- 地平线动态权重占比
    dyn_weight_illum REAL,                        -- 高空受光动态权重占比
    dyn_weight_atmo REAL,                         -- 大气质量动态权重占比
    dyn_weight_weather REAL,                      -- 天气风险动态权重占比
    
    -- 9. 用户真实观测反馈 (Ground Truth Label y)
    user_rating TEXT NOT NULL,                    -- 实况评级: great / good / fair / poor / accurate
    user_rating_label TEXT NOT NULL,              -- 评级中文标签 (如 🔥 极佳彩霞)
    user_comment TEXT,                            -- 用户选填说明/补充留言
    user_ip_hash TEXT,                            -- 客户端 IP 单向 SHA256 哈希 (脱敏防刷)
    client_ua TEXT,                               -- 客户端浏览器 User-Agent
    
    -- 10. 终极离线重演原始快照 (JSON 序列化)
    raw_snapshot_json TEXT                        -- 包含 33 节点网格小时序列与中间计算树的完整快照
);

-- 建立高频检索与训练筛选索引
CREATE INDEX IF NOT EXISTS idx_fb_city ON sunset_feedback(city);
CREATE INDEX IF NOT EXISTS idx_fb_created ON sunset_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_fb_created_epoch ON sunset_feedback(created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_fb_rate_limit ON sunset_feedback(user_ip_hash, city, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_fb_rating ON sunset_feedback(user_rating);
CREATE INDEX IF NOT EXISTS idx_fb_model_ver ON sunset_feedback(model_version);
CREATE INDEX IF NOT EXISTS idx_fb_score ON sunset_feedback(predicted_score);
