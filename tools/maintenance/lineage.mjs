#!/usr/bin/env node
import { canonicalJson, errorCode, fail, isMain } from '../dataset/lib/common.mjs';
import { createProgress, silentProgress } from '../progress.mjs';
import { parseLineageArgs } from './lib/args.mjs';
import { writeOutput } from './lib/output.mjs';
import { renderJson, renderMermaid, renderText } from './lib/render.mjs';
import { ancestorsOf, descendantsOf, nodeById, reduceEdgesForDrawing, scanDataset } from './lib/scan.mjs';
import { verifyPackages } from './lib/verify.mjs';

/**
 * Read-only Phase 1-6 lineage listing. The six published export roots are enumerated, every
 * manifest is read for identity and declared sources, and each published package becomes exactly
 * one graph node labelled with its full primary id.
 */
export async function datasetLineage(options) {
  const progress = options.progress || silentProgress;
  const graph = await scanDataset({ datasetRoot: options.datasetRoot, progress });
  let nodes = graph.nodes;
  let edges = graph.edges;
  let diagnostics = graph.diagnostics;
  if (options.focus) {
    if (!nodeById(graph, options.focus)) fail('MAINTENANCE_TARGET_MISSING', { target_id: options.focus });
    const keep = new Set([...ancestorsOf(graph, options.focus), ...descendantsOf(graph, options.focus)]);
    nodes = graph.nodes.filter(node => keep.has(node.id));
    edges = graph.edges.filter(edge => keep.has(edge.parent_id) && keep.has(edge.child_id));
    diagnostics = graph.diagnostics.filter(item =>
      item.node_id === null || keep.has(item.node_id) || keep.has(item.related_id));
  }
  progress.stage(options.verify ? '包内校验' : '生成检测报告');
  const verify = options.verify ? await verifyPackages(nodes, { progress }) : null;

  // The drawing shows direct relationships only; the JSON listing keeps every declared edge.
  const displayEdges = reduceEdgesForDrawing(edges);
  const hiddenEdges = edges.filter(edge => !displayEdges.includes(edge));

  let payload;
  if (options.format === 'mermaid') payload = renderMermaid(nodes, displayEdges, { grouped: options.group });
  else if (options.format === 'json') {
    payload = canonicalJson(renderJson(graph, {
      nodes, edges, displayEdges, diagnostics, focus: options.focus, verify
    }));
  } else {
    payload = renderText({ ...graph, diagnostics },
      { nodes, edges: displayEdges, hiddenEdges, grouped: options.group });
    if (verify) {
      const failed = verify.filter(item => item.status === 'FAIL');
      payload += `\n\nPackage internal verification: ${verify.length - failed.length}/${verify.length} pass`;
      for (const item of failed) payload += `\n  FAIL ${item.id}: ${item.error_code}`;
    }
  }

  let written = null;
  if (options.out) written = await writeOutput(options.datasetRoot, options.out, payload + '\n');
  progress.finish('完成：数据检测');
  return {
    payload, written, graph, nodes, edges, displayEdges, hiddenEdges, verify,
    status: graph.diagnostics.some(item => item.severity === 'ERROR') ? 'ATTENTION' : 'PASS'
  };
}

async function main() {
  let progress = silentProgress;
  try {
    const options = parseLineageArgs(process.argv.slice(2));
    progress = createProgress({ quiet: options.quiet });
    const result = await datasetLineage({ ...options, progress });
    console.log(result.payload);
    if (result.written && !options.quiet) progress.stage(`报告已写入 ${result.written}`);
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
