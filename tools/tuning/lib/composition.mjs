import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../../dataset/lib/common.mjs';
import { APP_ROOT } from './engine-runtime.mjs';

const PRODUCTION_FILE = 'js/prediction_service.js';
const RUNNER_FILE = 'tools/replay/replay-runner.mjs';

/**
 * Composition Parity gates the tuning result on the Replay runner reproducing the
 * production score composition step for step. Reference Parity alone only proves the
 * historical config point, so both are required before a Sensitivity package publishes.
 */
const CHECKS = [
  {
    id: 'SKY_EVOLUTION_FACTOR_CLAMP',
    note: '天空演化因子限幅区间必须一致',
    production: /var factor = SS\.domain\.clamp\(result\.sky_evolution_factor, 0\.65, 1\.15, 1\);/,
    runner: /SS\.domain\.clamp\(skyState\.factor, 0\.65, 1\.15, 1\)/
  },
  {
    id: 'GOLDEN_WINDOW_FACTOR_CLAMP',
    note: 'gwFactor 限幅必须使用 goldenWindow.floor 与上界 1',
    production: /SS\.domain\.clamp\(evo\.gwFactor, SS\.modelConfig\.goldenWindow\.floor, 1, 1\)/,
    runner: /SS\.domain\.clamp\(evo\.gwFactor, SS\.modelConfig\.goldenWindow\.floor, 1, 1\)/
  },
  {
    id: 'SCORE_COMPOSITION_ACTIVE_BRANCH',
    note: '黄金窗口激活分支：score × skyFactor × gwFactor 后四舍五入并限幅 0..100',
    production: /result\.score = Math\.round\(SS\.domain\.clamp\(result\.score \* factor \* gwFactor, 0, 100\)\);/,
    runner: /result\.score = Math\.round\(SS\.domain\.clamp\(result\.score \* SS\.domain\.clamp\(skyState\.factor, 0\.65, 1\.15, 1\) \* gwFactor, 0, 100\)\);/
  },
  {
    id: 'SCORE_COMPOSITION_INACTIVE_BRANCH',
    note: '黄金窗口未激活分支：只乘 skyFactor',
    production: /result\.score = Math\.round\(SS\.domain\.clamp\(result\.score \* factor, 0, 100\)\);/,
    runner: /result\.score = Math\.round\(SS\.domain\.clamp\(result\.score \* SS\.domain\.clamp\(skyState\.factor, 0\.65, 1\.15, 1\), 0, 100\)\);/
  },
  {
    id: 'BASE_SCORE_CAPTURED_BEFORE_COMPOSITION',
    note: 'base_score 必须在组合前记录',
    production: /result\.base_score = result\.score;/,
    runner: /result\.base_score = result\.score;/
  },
  {
    id: 'GOLDEN_WINDOW_ACTIVATION_SOURCE',
    note: '黄金窗口激活判定必须来自 SS.evolution.isGoldenWindowActive',
    production: /SS\.evolution\.isGoldenWindowActive\(context\)/,
    runner: /SS\.evolution\.isGoldenWindowActive\(\{ time \}\)/
  },
  {
    id: 'CONFIG_RESTORED_AFTER_RUN',
    note: 'runner 必须在 finally 中恢复 modelConfig，避免实验配置泄漏',
    production: null,
    runner: /finally \{\s*\n\s*SS\.modelConfig = current;/
  }
];

export async function verifyCompositionParity(root = APP_ROOT) {
  const [productionSource, runnerSource] = await Promise.all([
    readFile(path.join(root, PRODUCTION_FILE), 'utf8'),
    readFile(path.join(root, RUNNER_FILE), 'utf8')
  ]);
  const results = [];
  const failures = [];
  for (const check of CHECKS) {
    const production = check.production ? check.production.test(productionSource) : true;
    const runner = check.runner ? check.runner.test(runnerSource) : true;
    results.push({ id: check.id, note: check.note, production, runner });
    if (!production || !runner) failures.push({ id: check.id, production, runner });
  }
  if (failures.length) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COMPOSITION_PARITY_FAILED', detail: failures });
  }
  return {
    production_file: PRODUCTION_FILE,
    runner_file: RUNNER_FILE,
    checks: results,
    check_count: results.length
  };
}
