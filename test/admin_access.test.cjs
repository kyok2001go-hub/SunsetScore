const test = require('node:test');
const assert = require('node:assert/strict');

const ENV = {
  CF_ACCESS_TEAM_DOMAIN: 'https://sunsetscore-test.cloudflareaccess.com',
  CF_ACCESS_AUD: 'test-audience'
};

function request(host = 'admin.sunsetscore.ky-ok.com', token = 'signed-test-token', path = '/admin/backfill.html') {
  return new Request('https://' + host + path, {
    headers: token ? { 'cf-access-jwt-assertion': token } : {}
  });
}

function verifier(payload) {
  return {
    createRemoteJWKSet(url) {
      assert.equal(url.href, ENV.CF_ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs');
      return 'test-jwks';
    },
    async jwtVerify(token, jwks, options) {
      assert.equal(token, 'signed-test-token');
      assert.equal(jwks, 'test-jwks');
      assert.deepEqual(options, { issuer: ENV.CF_ACCESS_TEAM_DOMAIN, audience: ENV.CF_ACCESS_AUD });
      return { payload };
    }
  };
}

test('Access validation enforces admin Host and fail-closed configuration', async () => {
  const access = await import('../server/admin-access.js');
  assert.equal((await access.authenticateAdminRequest(request('sunsetscore.pages.dev'), ENV)).status, 404);
  assert.equal((await access.authenticateAdminRequest(request('admin.sunsetscore.ky-ok.com:8443'), ENV)).status, 404);
  assert.equal((await access.authenticateAdminRequest(request(undefined, null), ENV)).status, 401);
  assert.equal((await access.authenticateAdminRequest(request(), {})).status, 503);
  assert.equal((await access.authenticateAdminRequest(request(), {
    ...ENV,
    CF_ACCESS_TEAM_DOMAIN: 'https://example.com'
  })).status, 503);
});

test('Access validation derives human and service audit identities from verified claims', async () => {
  const access = await import('../server/admin-access.js');
  const human = await access.authenticateAdminRequest(request(), ENV, verifier({
    sub: 'user-subject', email: 'admin@example.test'
  }));
  assert.deepEqual(human, {
    ok: true,
    actor: { type: 'human', subject: 'admin@example.test', email: 'admin@example.test' }
  });

  const service = await access.authenticateAdminRequest(request(), ENV, verifier({
    sub: 'service-subject', common_name: 'github-backfill'
  }));
  assert.deepEqual(service, {
    ok: true,
    actor: { type: 'service', subject: 'github-backfill', email: null }
  });

  const rejected = await access.authenticateAdminRequest(request(), ENV, {
    createRemoteJWKSet: () => 'test-jwks',
    jwtVerify: async () => { throw new Error('signature mismatch'); }
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.code, 'invalid_access_token');
});

test('Pages middleware protects admin pages and APIs with no-store security headers', async () => {
  const middleware = await import('../functions/_middleware.js');
  let nextCalls = 0;
  const context = {
    request: request(),
    env: ENV,
    data: {},
    next: async () => {
      nextCalls += 1;
      return new Response('<main>admin</main>', { headers: { 'content-type': 'text/html' } });
    }
  };
  const response = await middleware.handleRequest(context, verifier({ email: 'admin@example.test' }));
  assert.equal(response.status, 200);
  assert.equal(nextCalls, 1);
  assert.equal(context.data.adminActor.email, 'admin@example.test');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');

  const bypass = await middleware.handleRequest({
    request: request('sunsetscore.pages.dev', 'signed-test-token', '/api/admin/observation-backfill'),
    env: ENV,
    data: {},
    next: async () => { throw new Error('must not run'); }
  }, verifier({ email: 'admin@example.test' }));
  assert.equal(bypass.status, 404);
});
