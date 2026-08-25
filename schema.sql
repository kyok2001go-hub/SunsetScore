-- SunsetScore V2.2 - Cloudflare D1 数据库初始化脚本
-- 用于存储真实用户查询预测特征向量 (X) 与晚霞实况观测标签 (y) 的对应数据集

CREATE TABLE IF NOT EXISTS sunset_feedback (
    id TEXT PRIMARY KEY,                           -- 记录唯一标识 (如 fb_1724567890_abcde)
    query_id TEXT NOT NULL,                       -- 对应单次查询快照唯一 ID (UUID)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, -- 记录创建时间 (UTC)
    
    -- 1. 地理与天文元数据
    city TEXT NOT NULL,                           -- 城市名
    country TEXT,                                 -- 国家/地区代码
    latitude REAL NOT NULL,                       -- 观测点纬度
    longitude REAL NOT NULL,                      -- 观测点经度
    timezone TEXT,                                -- 当地时区
    sunset_time_local TEXT,                       -- 当地日落时间 (YYYY-MM-DD HH:mm)
    sunset_azimuth REAL,                          -- 日落方位角 (度)
    
    -- 2. 预测输出指标 (Model Predictions)
    model_version TEXT NOT NULL,                  -- 模型版本 (如 2.2.0)
    predicted_score INTEGER NOT NULL,             -- 高级动力学预测总分 (0~100)
    predicted_level TEXT NOT NULL,                -- 预测等级 (极佳/好/一般/较差)
    baseline_score INTEGER,                       -- 极简基线模型得分 (0~100)
    baseline_level TEXT,                          -- 极简基线等级
    regime_label TEXT,                            -- 识别的天气型 (如 槽后清空型/弱受光型)
    sky_evolution_state TEXT,                     -- 全天天况宏观演化态 (CLEAR/OPENING/STABLE...)
    sky_evolution_factor REAL,                    -- 宏观演化因子 (0.65~1.15)
    
    -- 3. 核心物理特征向量 (Physical Feature Vector X)
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
    layer_wind_850_speed REAL,                    -- 850hPa 探空等压面风速 (km/h)
    layer_wind_850_dir REAL,                      -- 850hPa 探空等压面风向 (度)
    visibility_km REAL,                           -- 能见度 (km)
    precipitation REAL,                           -- 降水量 (mm)
    
    -- 4. 用户真实观测反馈 (Ground Truth Label y)
    user_rating TEXT NOT NULL,                    -- 实况评级: great / good / fair / poor / accurate
    user_rating_label TEXT NOT NULL,              -- 评级中文标签 (如 🔥 极佳彩霞)
    user_comment TEXT,                            -- 用户选填说明/补充留言
    user_ip_hash TEXT,                            -- 客户端 IP 单向 SHA256 哈希 (脱敏防刷)
    client_ua TEXT                                -- 客户端浏览器 User-Agent
);

-- 建立高频检索与训练筛选索引
CREATE INDEX IF NOT EXISTS idx_fb_city ON sunset_feedback(city);
CREATE INDEX IF NOT EXISTS idx_fb_created ON sunset_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_fb_rating ON sunset_feedback(user_rating);
CREATE INDEX IF NOT EXISTS idx_fb_model_ver ON sunset_feedback(model_version);
