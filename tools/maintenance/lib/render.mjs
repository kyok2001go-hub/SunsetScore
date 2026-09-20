import { PHASES } from '../maintenance-policy.mjs';

const ARROW = { SOURCE: '-->', REFERENCE: '-->', EVIDENCE: '-.->' };

function indexNodes(nodes) {
  return new Map(nodes.map((node, position) => [node.id, `n${position}`]));
}

/**
 * Mermaid keeps one node per published package and labels it with the full primary id only.
 * Paths, hashes and sizes stay in the machine readable listing so the graph stays readable.
 * Callers pass the reduced edge set: the drawing shows direct relationships between packages
 * (plus the validation disclosure evidence), not restated transitive sources.
 *
 * The flat form is the default because it only uses plain node and edge statements, which every
 * Mermaid renderer draws. `grouped` wraps each phase in a subgraph for a nicer picture, but that
 * adds cross-subgraph edges, a construct some embedded renderers silently drop.
 */
export function renderMermaid(nodes, edges, options = {}) {
  return options.grouped ? renderGroupedMermaid(nodes, edges) : renderFlatMermaid(nodes, edges);
}

function edgeLines(edges, aliases) {
  const lines = [];
  for (const edge of edges) {
    if (!aliases.has(edge.parent_id) || !aliases.has(edge.child_id)) continue;
    const label = edge.kind === 'SOURCE' ? '' : `|${edge.kind}|`;
    lines.push(`  ${aliases.get(edge.parent_id)} ${ARROW[edge.kind] || '-->'}${label} ${aliases.get(edge.child_id)}`);
  }
  return lines;
}

function renderFlatMermaid(nodes, edges) {
  const aliases = indexNodes(nodes);
  const lines = ['flowchart LR'];
  for (const phase of PHASES) {
    const group = nodes.filter(node => node.phase === phase.phase);
    if (!group.length) continue;
    lines.push(`  %% ${phase.label}`);
    for (const node of group) lines.push(`  ${aliases.get(node.id)}["${node.id}"]`);
  }
  lines.push(...edgeLines(edges, aliases));
  return lines.join('\n');
}

function renderGroupedMermaid(nodes, edges) {
  const aliases = indexNodes(nodes);
  const lines = ['flowchart LR'];
  for (const phase of PHASES) {
    const group = nodes.filter(node => node.phase === phase.phase);
    if (!group.length) continue;
    lines.push(`  subgraph P${phase.phase}["${phase.label}"]`);
    for (const node of group) lines.push(`    ${aliases.get(node.id)}["${node.id}"]`);
    lines.push('  end');
  }
  lines.push(...edgeLines(edges, aliases));
  return lines.join('\n');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function renderText(graph, options = {}) {
  const nodes = options.nodes || graph.nodes;
  const edges = options.edges || graph.edges;
  const hiddenEdges = options.hiddenEdges || [];
  const errors = graph.diagnostics.filter(item => item.severity === 'ERROR');
  const advisories = graph.diagnostics.filter(item => item.severity === 'ADVISORY');
  const lines = [];
  lines.push('SunsetScore dataset lineage');
  lines.push(`  dataset root : ${graph.dataset_root}`);
  lines.push(`  maintenance  : ${graph.maintenance.status}` +
    (graph.maintenance.active_leases.length ? ` (${graph.maintenance.active_leases.length} active lease)` : ''));
  for (const lease of graph.maintenance.lease_details || []) {
    lines.push(`                 lease ${lease.id} phase=${lease.phase ?? 'unknown'} pid=${lease.pid ?? 'unknown'} ${lease.started_at_utc ?? ''}`.trimEnd());
  }
  lines.push(`  packages     : ${nodes.length} (${PHASES
    .map(phase => `Phase ${phase.phase}: ${nodes.filter(node => node.phase === phase.phase).length}`)
    .join(', ')})`);
  lines.push(`  diagnostics  : ${errors.length} error, ${advisories.length} advisory`);
  for (const phase of PHASES) {
    const group = nodes.filter(node => node.phase === phase.phase);
    if (!group.length) continue;
    lines.push('');
    lines.push(`${phase.label}  (${group.length})`);
    for (const node of group) {
      lines.push(`  ${node.id}  ${node.file_count} file(s), ${formatBytes(node.bytes)}`);
    }
  }
  const labelled = edges.filter(edge => edge.kind !== 'SOURCE');
  if (labelled.length) {
    lines.push('');
    lines.push('Non-source dependencies');
    for (const edge of labelled) {
      lines.push(`  ${edge.parent_id} -> ${edge.child_id}  ${edge.kind} (${edge.id_field})`);
    }
  }
  if (hiddenEdges.length) {
    lines.push('');
    lines.push(`Transitive edges left out of the drawing (${hiddenEdges.length}); prune still uses them`);
    for (const edge of hiddenEdges) {
      lines.push(`  ${edge.parent_id} -> ${edge.child_id}  ${edge.kind} (${edge.id_field})`);
    }
  }
  if (graph.diagnostics.length) {
    lines.push('');
    lines.push('Diagnostics');
    for (const item of graph.diagnostics) {
      lines.push(`  [${item.severity}] ${item.code}` +
        (item.node_id ? ` node=${item.node_id}` : '') +
        (item.related_id ? ` related=${item.related_id}` : '') +
        (item.detail ? ` detail=${JSON.stringify(item.detail)}` : ''));
    }
  }
  lines.push('');
  lines.push(renderMermaid(nodes, edges, { grouped: options.grouped }));
  return lines.join('\n');
}

export function renderJson(graph, options = {}) {
  const nodes = options.nodes || graph.nodes;
  const edges = options.edges || graph.edges;
  const displayEdges = options.displayEdges || edges;
  const diagnostics = options.diagnostics || graph.diagnostics;
  const counts = {};
  const totals = {};
  for (const phase of PHASES) {
    counts[phase.phase] = nodes.filter(node => node.phase === phase.phase).length;
    totals[phase.phase] = graph.nodes.filter(node => node.phase === phase.phase).length;
  }
  return {
    status: graph.diagnostics.some(item => item.severity === 'ERROR') ? 'ATTENTION' : 'PASS',
    maintenance_schema_version: 1,
    dataset_root: graph.dataset_root,
    maintenance_root: graph.maintenance_root,
    generated_at_utc: new Date().toISOString(),
    maintenance: graph.maintenance,
    focus: options.focus ?? null,
    package_count: nodes.length,
    dataset_package_count: graph.nodes.length,
    phase_counts: counts,
    dataset_phase_counts: totals,
    roots: graph.roots,
    nodes,
    edges,
    display_edges: displayEdges,
    drawing: {
      edge_count: edges.length,
      drawn_edge_count: displayEdges.length,
      hidden_edge_count: edges.length - displayEdges.length
    },
    diagnostics,
    ...(options.verify ? { verify: options.verify } : {})
  };
}
