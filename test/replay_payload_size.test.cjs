const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');

test('Replay processing accepts the 100/400/1536 KiB canonical boundaries', async () => {
  const schema = await import('../server/replay-schema.js');
  const { createSizedReplay } = await import('../tools/replay/replay-fixture.mjs');
  for (const target of [100 * 1024, 400 * 1024, schema.MAX_REPLAY_UNCOMPRESSED_BYTES]) {
    const replay = await createSizedReplay(target);
    const validated = await schema.validateReplayPayload(replay);
    const serialized = schema.canonicalJson(validated);
    assert.equal(schema.assertReplayUncompressedSize(serialized), target);
    assert.match(createHash('sha256').update(serialized).digest('hex'), /^[a-f0-9]{64}$/);
    assert.ok(gzipSync(serialized).byteLength > 0);
  }
});

test('Replay and HTTP envelope limits have distinct inclusive semantics', async () => {
  const schema = await import('../server/replay-schema.js');
  const { createSizedReplay } = await import('../tools/replay/replay-fixture.mjs');
  const exact = await createSizedReplay(schema.MAX_REPLAY_UNCOMPRESSED_BYTES);
  assert.equal(schema.assertReplayUncompressedSize(schema.canonicalJson(exact)), schema.MAX_REPLAY_UNCOMPRESSED_BYTES);
  const tooLarge = await createSizedReplay(schema.MAX_REPLAY_UNCOMPRESSED_BYTES + 1);
  assert.throws(() => schema.assertReplayUncompressedSize(schema.canonicalJson(tooLarge)), /Replay 未压缩内容过大/);
  assert.equal(schema.REPLAY_MAX_BODY_BYTES, 2048 * 1024);
  assert.equal(schema.REPLAY_GZIP_WARN_BYTES, 500 * 1024);
});
