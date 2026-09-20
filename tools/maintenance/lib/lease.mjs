import path from 'node:path';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { canonicalJson, compare, errorCode, fail, runId, safePath } from '../../dataset/lib/common.mjs';
import { DEFAULT_DATASET_ROOT } from '../maintenance-policy.mjs';

/**
 * Shared maintenance gate.
 *
 * Builders take a shared lease before they touch `exports`, then confirm the exclusive gate is
 * free. Prune takes the exclusive gate, then confirms no shared lease is live. Both directions
 * use an atomic `mkdir`, so whichever side wins the race, the other one observes it and stops.
 *
 * A lease or gate left behind by a killed process is never guessed away; the operator has to
 * confirm the owning process is gone first.
 */
const MAINTENANCE_DIR_NAME = 'maintenance';
const GATE_NAME = 'gate.lock';
const LEASES_NAME = 'leases';
const QUARANTINE_NAME = 'quarantine';
const PLANS_NAME = 'plans';

export function maintenanceRoot(datasetRoot = DEFAULT_DATASET_ROOT) {
  return path.join(path.resolve(datasetRoot), MAINTENANCE_DIR_NAME);
}

export function gatePath(datasetRoot) {
  return path.join(maintenanceRoot(datasetRoot), GATE_NAME);
}

export function leasesPath(datasetRoot) {
  return path.join(maintenanceRoot(datasetRoot), LEASES_NAME);
}

export function quarantineRoot(datasetRoot) {
  return path.join(maintenanceRoot(datasetRoot), QUARANTINE_NAME);
}

export function defaultPlanDirectory(datasetRoot = DEFAULT_DATASET_ROOT) {
  return path.join(maintenanceRoot(datasetRoot), PLANS_NAME);
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function listLeases(datasetRoot) {
  try {
    const entries = await readdir(leasesPath(datasetRoot), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(compare);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Read-only view used by lineage reporting and by the plan gate. */
export async function inspectMaintenanceState(datasetRoot = DEFAULT_DATASET_ROOT) {
  const root = maintenanceRoot(datasetRoot);
  const leases = await listLeases(datasetRoot);
  const details = [];
  for (const id of leases) details.push({ id, ...await describeLease(datasetRoot, id) });
  return {
    dataset_root: path.resolve(datasetRoot),
    maintenance_root: root,
    gate_active: await exists(gatePath(datasetRoot)),
    active_leases: leases,
    lease_details: details,
    status: (await exists(gatePath(datasetRoot))) ? 'MAINTENANCE_ACTIVE' : (leases.length ? 'BUILD_ACTIVE' : 'IDLE')
  };
}

/**
 * Shared lease held for the whole lifetime of a build. The post-lease gate check is what makes
 * "builder creates lease, then prune creates gate" safe in both interleavings.
 */
export async function withBuildLease(phaseKey, operation, options = {}) {
  const datasetRoot = path.resolve(options.datasetRoot || DEFAULT_DATASET_ROOT);
  const leaseDirectory = path.join(leasesPath(datasetRoot), runId());
  await safePath(leaseDirectory);
  await mkdir(leaseDirectory, { recursive: true });
  try {
    await writeFile(path.join(leaseDirectory, 'lease.json'), canonicalJson({
      lease_schema_version: 1,
      phase: phaseKey,
      pid: process.pid,
      started_at_utc: new Date().toISOString()
    }), { encoding: 'utf8', flag: 'wx' });
    if (await exists(gatePath(datasetRoot))) fail('DATASET_MAINTENANCE_ACTIVE', { phase: phaseKey });
    return await operation();
  } finally {
    await rm(leaseDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Exclusive window for destructive maintenance. Refuses to start while any build lease is live. */
export async function withMaintenanceWindow(operation, options = {}) {
  const datasetRoot = path.resolve(options.datasetRoot || DEFAULT_DATASET_ROOT);
  const gate = gatePath(datasetRoot);
  await safePath(gate);
  await mkdir(maintenanceRoot(datasetRoot), { recursive: true });
  try {
    await mkdir(gate);
  } catch (error) {
    if (error.code === 'EEXIST') fail('DATASET_MAINTENANCE_BUSY');
    throw error;
  }
  try {
    const leases = await listLeases(datasetRoot);
    if (leases.length) fail('DATASET_BUILD_ACTIVE', { active_leases: leases });
    return await operation();
  } finally {
    await rm(gate, { recursive: true, force: true }).catch(() => {});
  }
}

/** Human readable lease owner, used by lineage output so an operator can find the process. */
export async function describeLease(datasetRoot, leaseId) {
  try {
    const bytes = await readFile(path.join(leasesPath(datasetRoot), leaseId, 'lease.json'));
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { lease_schema_version: null, unreadable: errorCode(error) };
  }
}
