export function bindEngineRoot(root) {
  const key = Symbol.for('SunsetScore.engineRoot');
  if (globalThis[key] && globalThis[key] !== root) throw new Error('MULTIPLE_ENGINE_ROOTS_UNSUPPORTED');
  globalThis[key] = root;
  return root;
}
