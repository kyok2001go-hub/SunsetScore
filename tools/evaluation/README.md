# Baseline Evaluation 工具使用说明 (Phase 4)

本工具为 SunsetScore V2.5.1 Phase 4 Baseline Evaluation 的离线实现，用于对冻结的 V2.5.0 Model Dataset 建立历史生产预测基线，量化误差并识别误差模式，为 Phase 5 Sensitivity Analysis 提供固定参照。

本工具为纯本地 Node.js 工具，不联网、不调用外部 API、不修改生产数据库或应用代码。

---

## 1. 核心架构与隔离保证

### 1.1 两个独立阶段
1. **上游数据包验收阶段 (Model SOURCE_LINKED)**：
   - 正式构建必须显式传入 `--raw` 与 `--gt`。
   - 调用完整校验器对 Model、Raw 与 GT 进行全链路来源验收。
   - 上游验收可读取 `test.csv` 以确保数据包完整性与划分合法性，但**绝不计算 TEST 效果、不向评估阶段传递 TEST 样本或标签**。
2. **受限评估计算与重算阶段 (Restricted Whitelist Reader)**：
   - 严格仅通过白名单读取以下 5 个文件：
     - `manifest.json`
     - `schema.json`
     - `policy.json`
     - `splits/train.csv`
     - `splits/validation.csv`
   - 任何对 `test.csv`、`model_samples.csv`、`event_splits.csv` 或上游 `reports/` 的读取尝试均会被受限读取器直接拦截并报错。
   - Manifest 中固定记录：
     ```json
     {
       "evaluated_splits": ["TRAIN", "VALIDATION"],
       "test_evaluated": false,
       "test_evaluation_sample_count": 0,
       "upstream_validation_scope": "SOURCE_LINKED",
       "test_access_policy": "UPSTREAM_VALIDATION_ONLY"
     }
     ```

### 1.2 确定性身份与不可变发布
- 遵循不可变数据包契约：
  - 临时 Staging 目录写入全部产物并完成自校验。
  - 目标排他文件锁（10 秒超时）。
  - 来源指纹（Fingerprints）前置与锁内双重比对。
  - 原子性 `rename` 发布。
  - 同内容重复构建自动去重返回 `DEDUPLICATED`；同 ID 内容冲突报错 `EVALUATION_ID_CONFLICT`。
- 确定性 ID：
  - `model_short = model_dataset_descriptor_sha256[0..12]`
  - `evaluation_id = baseline_v1_<model_short>_<hash12>`
  - 包内完全不写入动态时间戳 `created_at`、工具版本或本机绝对路径，保证完全位级可重现。

---

## 2. npm 入口与命令行用法

在 `SunsetScore-main/` 目录下执行以下命令：

### 2.1 评估 Baseline (`evaluation:baseline`)
```bash
npm run evaluation:baseline -- --model <model_dir> --raw <raw_dir> --gt <gt_dir> [--output <output_root>] [--quiet]
```
- `--model <dir>`: 必须，已冻结的 Model 数据包目录路径。
- `--raw <dir>`: 必须，对应的 Raw 数据包目录路径（用于 Model SOURCE_LINKED 验收）。
- `--gt <dir>`: 必须，对应的 Ground Truth 数据包目录路径。
- `--output <dir>`: 可选，评估包输出根目录，默认值为 `dataset/evaluation`。
- `--quiet`: 可选，静音进度输出（仅向 stdout 输出最终规范 JSON）。

示例：
```bash
npm run evaluation:baseline -- \
  --model dataset/model/exports/model_v2_ec472a1ae79a_a7e4b16fa93e_7e48bb52a4b9 \
  --raw dataset/exports/raw_v1_20260907_20260914_ec472a1ae79a \
  --gt dataset/ground_truth/exports/gt_v3_ec472a1ae79a_a7e4b16fa93e
```

### 2.2 校验评估包 (`evaluation:validate`)
```bash
npm run evaluation:validate -- <evaluation_dir> [--model <model_dir>] [--report-dir <report_dir>] [--quiet]
```
- `<evaluation_dir>`: 必须，评估数据包目录路径。
- `--model <dir>`: 可选。不传时执行 `PACKAGE_INTERNAL` 内部完整性校验；传入时执行 `MODEL_LINKED` 来源关联校验（受限读取 Model 白名单数据，重算全部指标与文件并进行逐字节比对）。
- `--report-dir <dir>`: 可选，将校验结果报告 `validation.json` 写入指定外部目录。
- `--quiet`: 可选，静音进度输出。

### 2.3 查看统计摘要 (`evaluation:stats`)
```bash
npm run evaluation:stats -- <evaluation_dir> [--report-dir <report_dir>] [--quiet]
```
- `<evaluation_dir>`: 必须，评估数据包目录路径。
- 执行内部自洽校验后，输出核心指标、各 Benchmark/Split 计数与警告汇总。
- `--report-dir <dir>`: 可选，将统计结果 `statistics.json` 写入指定外部目录。

---

## 3. 输出产物结构

```text
dataset/evaluation/
├─ staging/<run_id>/
└─ exports/<evaluation_id>/
   ├─ manifest.json               # 评估包全局元数据、版本、Hash、文件清单
   ├─ schema.json                 # 冻结的字段清单、数据类型与 CSV/JSON 规范 (Schema V1)
   ├─ policy.json                 # 冻结的评估策略与计算规则 (Policy V1)
   ├─ overall_metrics.json        # 主指标、QWK、提前量覆盖、排序诊断 (Spearman)
   ├─ confusion_matrix.csv        # 5x5 混淆矩阵 (样本计数与权重之和)
   ├─ slice_metrics.csv           # 14 个单维切片分析、重归一化权重与覆盖判定
   ├─ score_distribution.csv      # 5 级真实标签下的预测分数分布 (分位数与极值)
   ├─ baseline_comparison.csv     # Final vs Internal Baseline 成对比较与胜率
   ├─ error_cases.csv             # 全部误差大于 0 的样本详情 (标记 CLOSEST)
   └─ reports/
      ├─ summary.json             # 汇总报告、高置信严重错误比率、Top 20 Worst Cases
      └─ warnings.csv             # 确定性提示与覆盖告警 (去重并排序)
```

---

## 4. 评估指标与算法要点

1. **Prediction → Ordinal 映射**：
   - 0–19: 0 (`poor`)
   - 20–39: 1 (`fair`)
   - 40–59: 2 (`good`)
   - 60–89: 3 (`very_good`)
   - 90–100: 4 (`excellent`)
   - 严格数值映射，不解析文本；非法值直接失败。
2. **两组 Benchmark**：
   - `ALL_PRIMARY`: 全体 PRIMARY 样本，使用 `event_normalized_weight`。
   - `CLOSEST_PRE_SUNSET`: 每个 Event 选日落前最接近（`lead_time_minutes >= 0` 且最小）的一次预测，并列时按 `prediction_time_epoch` 降序、`snapshot_id` 字典序升序。权重为 `gt_confidence`。
3. **四组主体 + 合并重算**：
   - `ALL_PRIMARY` × `TRAIN`
   - `ALL_PRIMARY` × `VALIDATION`
   - `CLOSEST_PRE_SUNSET` × `TRAIN`
   - `CLOSEST_PRE_SUNSET` × `VALIDATION`
   - 另输出 `split = TRAIN_VALIDATION` 合并重算结果（非简单平均指标）。
4. **Quadratic Weighted Kappa (QWK)**：
   - 固定 5×5 惩罚矩阵 $D_{ab} = (a - b)^2 / 16$。
   - 期望惩罚分母为 0 时返回 `null` 并附带原因码 `QWK_ZERO_EXPECTED_DISAGREEMENT`。
5. **Final vs Internal Baseline (Paired)**：
   - 先选定 Benchmark，再筛 `baseline_score != null`。
   - 在配对样本中按 Event 重新归一化权重；最近样本缺少 Baseline 时不回退至早期样本。
   - 输出 Final 相对 Baseline 的胜率、平率、负率及 MAE 差值。
6. **分位数与 Spearman 秩相关**：
   - 分位数采用线性插值算法 $h = (n-1)p$。
   - Spearman 处理并列秩（平均秩），退化时输出原因码 `CONSTANT_INPUT` 或 `INSUFFICIENT_SAMPLES`。
7. **数值规范与空值原因**：
   - 中间计算不舍入，结果按 12 位小数保留，负零规范为 0。
   - 空值指标均有对应的 `<metric>_reason_code` 或 `metric_reasons` 说明原因。

---

## 5. 校验分层

`evaluation:validate` 分两层，结论不可互相替代：

- `PACKAGE_INTERNAL`：文件清单、Schema / Policy、canonical 编码、Hash / bytes / rows、descriptor 与 Evaluation ID、混淆矩阵 25 格坐标唯一性与总量、由矩阵复算的主指标与 QWK、Slice 维度唯一性、分布与 Worst Cases 与 summary 的一致性。
- `MODEL_LINKED`：在内部校验之后，仅用受限读取器重算全部结果文件并逐字节比对；不重新执行 Raw / GT 来源验收。

上游 Model SOURCE_LINKED 验收、`PACKAGE_INTERNAL`、Evaluation `MODEL_LINKED` 是三种不同强度的结论。正式发布要求前两者与 `MODEL_LINKED` 同时成立；只有 `PACKAGE_INTERNAL` 通过不能证明指标来自正确的源样本。

篡改 `overall_metrics.json` 或 `summary.json` 中的主指标、即使同步改写文件 Hash 与 Evaluation ID，也会在矩阵复算阶段以 `METRIC_TAMPER_DETECTED` 失败。
