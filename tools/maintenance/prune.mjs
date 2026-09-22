#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, errorCode, fail, isMain } from '../dataset/lib/common.mjs';
import { createProgress, silentProgress } from '../progress.mjs';
import { parsePruneArgs } from './lib/args.mjs';
import { defaultPlanDirectory } from './lib/lease.mjs';
import { applyPrunePlan, buildPrunePlan, planSummary, writePlan } from './lib/plan.mjs';
import { nodeById, scanDataset } from './lib/scan.mjs';

/**
 * Cascade removal for Phase 1-6 packages.
 *
 * `dataset:prune -- <id>` is the everyday form: the phase is read from the manifest, the
 * dependent closure is resolved, a frozen plan is written under `dataset/maintenance/plans/`,
 * and the packages are removed Phase 6 -> Phase 1. `--dry-run` previews the same closure without
 * deleting, and `--plan` / `--apply` / `--resume` remain for explicit two step control.
 */
export async function datasetPrune(options) {
  const progress = options.progress || silentProgress;
  if (options.mode === 'auto') {
    progress.stage('扫描六阶段发布目录');
    const graph = await scanDataset({ datasetRoot: options.datasetRoot, progress });
    const target = nodeById(graph, options.id);
    if (!target) fail('MAINTENANCE_TARGET_MISSING', { target_id: options.id });
    if (options.phase !== null && options.phase !== undefined && target.phase !== options.phase) {
      fail('MAINTENANCE_TARGET_MISSING', {
        reason_code: 'PHASE_MISMATCH', target_id: options.id,
        detail: { declared_phase: target.phase, requested_phase: options.phase }
      });
    }
    progress.stage('计算下游依赖闭包');
    const plan = buildPrunePlan({ graph, targetId: options.id, datasetRoot: graph.dataset_root });
    const planPath = path.join(defaultPlanDirectory(graph.dataset_root), `${options.id}.json`);
    const written = await writePlan(planPath, plan, { overwrite: true });
    if (plan.status !== 'READY') {
      progress.finish('完成：清理计划被阻断');
      return {
        status: 'BLOCKED', plan_file: written, plan_sha256: plan.plan_sha256,
        target: plan.target, targets: plan.targets.map(summarizeTarget),
        execution_order: plan.execution_order, blockers: plan.blockers, advisories: plan.advisories
      };
    }
    if (options.dryRun) {
      progress.finish('完成：仅预览，未删除任何数据');
      return {
        status: 'PLANNED', dry_run: true, plan_file: written, plan_sha256: plan.plan_sha256,
        target: plan.target, targets: plan.targets.map(summarizeTarget),
        execution_order: plan.execution_order, summary: planSummary(plan),
        blockers: plan.blockers, advisories: plan.advisories
      };
    }
    progress.stage(`删除 ${plan.targets.length} 个数据包（Phase 6 → Phase 1）`);
    const result = await applyPrunePlan({
      planPath: written, datasetRoot: graph.dataset_root, resume: false, progress
    });
    progress.finish(`完成：已清理 ${result.deleted_count} 个数据包`);
    return { ...result, targets: plan.targets.map(summarizeTarget), summary: planSummary(plan) };
  }
  if (options.mode === 'plan') {
    progress.stage('扫描六阶段发布目录');
    const graph = await scanDataset({ datasetRoot: options.datasetRoot, progress });
    const target = nodeById(graph, options.id);
    if (!target) fail('MAINTENANCE_TARGET_MISSING', { target_id: options.id });
    if (options.phase !== null && options.phase !== undefined && target.phase !== options.phase) {
      fail('MAINTENANCE_TARGET_MISSING', {
        reason_code: 'PHASE_MISMATCH', target_id: options.id,
        detail: { declared_phase: target.phase, requested_phase: options.phase }
      });
    }
    progress.stage('计算下游依赖闭包');
    const plan = buildPrunePlan({ graph, targetId: options.id, datasetRoot: graph.dataset_root });
    const written = await writePlan(options.planPath, plan);
    progress.finish(plan.status === 'READY' ? '完成：清理计划已生成' : '完成：清理计划被阻断');
    return {
      status: plan.status,
      plan_file: written,
      plan_sha256: plan.plan_sha256,
      graph_sha256: plan.graph_sha256,
      target: plan.target,
      dataset_root: plan.dataset_root,
      targets: plan.targets.map(item => ({
        phase: item.phase, id: item.id, relative_path: item.relative_path,
        manifest_sha256: item.manifest_sha256, reasons: item.reasons
      })),
      execution_order: plan.execution_order,
      edges: plan.edges,
      summary: planSummary(plan),
      blockers: plan.blockers,
      advisories: plan.advisories
    };
  }
  const resume = options.resume === true || options.mode === 'resume';
  progress.stage(resume ? '恢复清理' : '执行清理');
  const result = await applyPrunePlan({
    planPath: options.planPath,
    datasetRoot: options.datasetRoot,
    resume,
    progress
  });
  progress.finish(`完成：已清理 ${result.deleted_count} 个数据包`);
  return result;
}

function summarizeTarget(target) {
  return {
    phase: target.phase, id: target.id, relative_path: target.relative_path,
    manifest_sha256: target.manifest_sha256, file_count: target.file_count,
    bytes: target.bytes, reasons: target.reasons
  };
}

async function main() {
  let progress = silentProgress;
  try {
    const options = parsePruneArgs(process.argv.slice(2));
    progress = createProgress({ quiet: options.quiet });
    const result = await datasetPrune({ ...options, progress });
    console.log(canonicalJson(result));
  } catch (error) {
    progress.fail(errorCode(error));
    console.log(canonicalJson({
      status: 'FAIL', error_code: errorCode(error),
      ...(error.reason_code ? { reason_code: error.reason_code } : {})
    }));
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
