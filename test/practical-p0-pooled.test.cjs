const test = require('node:test');
const assert = require('node:assert/strict');
// V2.5.5.14 pooled P0 (Practical Tuning Policy 13). PRD: ref_docs/PRD/V2.5.5.14--P0机制诊断合并数据重跑方案.md
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/p0-features', 'practical-tuning/p0-pooled-workflow', 'practical-tuning/policy']
  .map(n => import(`../tools/${n}.mjs`))).then(([features, pooled, policy]) => ({ ...features, ...pooled, digest: policy.digest })); }

test('Policy 13 keeps the frozen Policy 9 plan and only changes data, baseline, the H3 guard, the other slot and two rules', async () => {
  const m = await api(), p = m.P0_POOLED_POLICY, o = m.P0_POLICY;
  assert.equal(m.digest(o), '764941789bebc013e25003d4b6ba5e57a3bfb2e9407850a671d99f4db5581bde', 'Policy 9 plan unchanged');
  for (const key of ['thresholds', 'group_priority', 'support', 'slots', 'bins', 't_avg_bins', 'probes', 'probe_spot_checks', 'logistic', 'bootstrap',
    'feature_ids', 'bin_variables', 'conditional_bin_variables', 'atmosphere_variables', 'blocking_mid_share', 'blocking_node_threshold', 'decision_rules_version', 'reference'])
    assert.deepEqual(p[key], o[key], key);
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.baseline, p.h3_first_date], [13, 13, 'RELEASE_LINE_2.5.5.11', '2026-11-16']);
  assert.deepEqual(p.pools.map(x => x.name), ['DEV', 'H1', 'H2']);
  assert.deepEqual(p.pools.map(x => x.snapshots), [655, 393, 329]);
  for (let i = 1; i < p.pools.length; i++) assert.ok(p.pools[i].first_date > p.pools[i - 1].last_date, 'pools do not overlap');
  assert.ok(p.pools.at(-1).last_date < p.h3_first_date, 'no pool reaches H3');
  assert.equal(p.pools[0].raw, o.dev.raw);
});

test('Pooled loader refuses pools that are missing, renamed or out of order before reading anything', async () => {
  const m = await api(), pools = m.defaultPools('/nonexistent');
  await assert.rejects(m.loadPooled(pools.slice(0, 2)), e => e.code === 'P0_POOLED_POOLS_INVALID');
  await assert.rejects(m.loadPooled([pools[1], pools[0], pools[2]]), e => e.code === 'P0_POOLED_POOLS_INVALID');
  assert.deepEqual(pools.map(p => p.name), ['DEV', 'H1', 'H2']);
});

test('Supplementary rules: already-tested directions need a different change; a G1 severe-miss excess forces the mid/high response', async () => {
  const m = await api();
  const stab = over => ({ 'G1.miss': { evidence: false, direction: 1 }, 'G2.false_alarm': { evidence: false, direction: 1 }, 'G3.miss': { evidence: false }, ...over });
  const severe = lower => lower == null ? null : { status: 'COMPUTED', point: lower + .05, ci95: [lower, lower + .1], significant: lower > 0 };
  const D1 = (over = {}, severeLower = null) => ({ stability: stab(over),
    attribution: { questions: { q1_g1_miss_loss: { status: 'COMPUTED', main_loss_stage: 'cloud' }, q2_g2_false_alarm: { status: 'COMPUTED', horizon_high: true } } },
    sets: { primary: { PRIMARY_LAST: { G1: { metrics: { severe_miss: { difference: severe(severeLower) } } } } } } });
  const probe = lower => ({ status: 'COMPUTED', ci95: [lower, lower + .1] });
  const D2 = ({ gwp1 = -.01, gwp2 = -.01, indist = false } = {}) => ({ probes: { 'GWP-1': { delta_auc_ge2: probe(gwp1) }, 'GWP-2': { delta_auc_ge2: probe(gwp2) } }, core: { indistinguishable: indist } });
  const D3 = (rh = 'UNRESOLVED', aod = 'UNRESOLVED') => ({ bins: [{ label: 'rh', shape: rh }, { label: 'aod', shape: aod }], redundancy: { drop_one: {} } });
  const status = d => d.recommendations.map(r => r.status);
  // Order: GW, mid/high response, atmosphere, corridor bottleneck.
  assert.deepEqual(status(m.decidePooled(D1(), D2(), D3())), ['DATA_LIMITED', 'DATA_LIMITED', 'DATA_LIMITED', 'DATA_LIMITED']);
  // GW indistinguishable (the retired layered proxy) and an AOD shape (V2.5.5.5) are already tested.
  const tested = m.decidePooled(D1(), D2({ indist: true }), D3('UNRESOLVED', 'MONOTONE_DEC'));
  assert.deepEqual(status(tested), ['ALREADY_TESTED', 'DATA_LIMITED', 'ALREADY_TESTED', 'DATA_LIMITED']);
  assert.deepEqual(tested.base_recommendations.map(r => r.status), ['PRIORITY_1', 'DATA_LIMITED', 'PRIORITY_2', 'DATA_LIMITED']);
  assert.match(tested.recommendations[0].already_tested, /V2\.5\.5\.6/); assert.match(tested.recommendations[2].already_tested, /V2\.5\.5\.5/);
  // A GWP-2 gain (G1 exemption) or a monotone RH shape point to a change that was not tested.
  assert.deepEqual(status(m.decidePooled(D1(), D2({ gwp2: .001 }), D3('MONOTONE_INC'))), ['PRIORITY_1', 'DATA_LIMITED', 'PRIORITY_2', 'DATA_LIMITED']);
  // G1 severe-miss excess: the mid/high response is recommended even though the miss attribution did not trigger it.
  const forced = m.decidePooled(D1({}, .01), D2({ indist: true }), D3());
  assert.deepEqual(status(forced), ['ALREADY_TESTED', 'PRIORITY_1', 'DATA_LIMITED', 'DATA_LIMITED']);
  assert.equal(forced.recommendations[1].forced_by_g1_severe_miss, true); assert.equal(forced.evidence.G1_severe_miss_significant, true);
  assert.equal(m.decidePooled(D1({}, -.01), D2(), D3()).recommendations[1].status, 'DATA_LIMITED', 'interval touching 0 does not force');
  assert.equal(m.decidePooled(D1({}, null), D2(), D3()).evidence.G1_severe_miss_significant, false, 'not estimable does not force');
  const both = m.decidePooled(D1({ 'G2.false_alarm': { evidence: true, direction: 1 } }, .02), D2({ gwp2: .002 }), D3());
  assert.deepEqual(status(both), ['PRIORITY_1', 'PRIORITY_2', 'DATA_LIMITED', 'PRIORITY_3']);
  assert.deepEqual([both.supplementary_rules_version, both.rules_version, both.requires_owner_confirmation], [1, 1, true]);
});
