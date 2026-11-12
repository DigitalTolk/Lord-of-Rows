// A tiny in-process Access API server (docs/access-api.md), the access provider used by
// the E2E tests. It implements just the endpoints the app calls, with the same shapes and
// status codes: desktop sign-in (PKCE, loopback redirect), services + targets, requests,
// approvals and credential reveal. Test code drives approval / provisioning directly.
import crypto from 'node:crypto';
import http from 'node:http';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startMockAccessProvider({ dbHost = 'postgres', dbPort = 5432, dbUser = 'dbs_test', dbPassword = 'dbs_test' } = {}) {
  const TOKEN = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const me = { userId: 'u-dev', email: 'dev@example.com', name: 'Dev', role: 'manager', isActive: true, managerId: 'u-mgr' };
  const services = [
    { serviceId: 'svc-orders', name: 'orders-db', environmentId: 'e1', environmentName: 'staging', driverKey: 'rds-postgres', isActive: true, config: { endpoint: dbHost, port: dbPort, engine: 'postgres' } },
    { serviceId: 'svc-docs', name: 'docs-db', environmentId: 'e1', environmentName: 'staging', driverKey: 'documentdb', isActive: true, config: { endpoint: 'docs.example.com' } },
    { serviceId: 'svc-ssm', name: 'app-secrets', environmentId: 'e1', environmentName: 'staging', driverKey: 'ssm', isActive: true },
  ];
  const state = {
    challenge: null,
    codes: new Map(),
    reveals: 0,
    requests: [
      // Someone else's request, waiting for this (manager) user.
      { requestId: 'req-other', userId: 'u-robin', serviceInstanceId: 'svc-orders', status: 'pending', requestType: 'developer', accessType: 'read', reason: 'Investigate a billing ticket', targetDatabases: ['dbs_test'], createdAt: new Date(Date.now() - 2 * 3600e3).toISOString() },
    ],
    log: [],
  };
  const enrich = (r) => {
    const s = services.find((x) => x.serviceId === r.serviceInstanceId) ?? {};
    const people = { 'u-dev': ['Dev', 'dev@example.com'], 'u-robin': ['Robin', 'robin@example.com'] };
    const [rn, re] = people[r.userId] ?? ['', ''];
    return {
      ...r,
      serviceName: s.name,
      environmentName: s.environmentName,
      driverKey: s.driverKey,
      endpoint: s.config?.endpoint,
      port: s.config?.port,
      engine: s.config?.engine,
      database: (r.targetDatabases ?? []).join(', '),
      requesterName: rn,
      requesterEmail: re,
      managerName: 'Morgan',
      managerEmail: 'manager@example.com',
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    let body = '';
    for await (const c of req) body += c;
    const json = (status, v) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(v === undefined ? '' : JSON.stringify(v));
    };
    state.log.push(`${req.method} ${path}`);

    if (req.method === 'GET' && path === '/api/v1/auth/desktop/start') {
      const ru = url.searchParams.get('redirect_uri') ?? '';
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(ru) || url.searchParams.get('code_challenge_method') !== 'S256' || (url.searchParams.get('code_challenge') ?? '').length !== 43) return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirectUri: ru });
      res.writeHead(302, { location: `${ru}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}` });
      return res.end();
    }
    if (req.method === 'POST' && path === '/api/v1/auth/desktop/token') {
      const v = JSON.parse(body || '{}');
      const grant = state.codes.get(v.code);
      state.codes.delete(v.code); // a code is single-use, even when the exchange fails
      if (!grant || grant.redirectUri !== v.redirect_uri || b64url(crypto.createHash('sha256').update(v.code_verifier ?? '').digest()) !== grant.challenge) return json(400, { error: 'invalid_grant' });
      return json(200, { token: TOKEN, tokenId: 't1', expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400, user: me });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'invalid or expired token' });

    if (req.method === 'GET' && path === '/api/v1/auth/me') return json(200, { user: me, csrfToken: '' });
    if (req.method === 'POST' && path === '/api/v1/auth/logout') return json(204);
    if (req.method === 'GET' && path === '/api/v1/services') return json(200, { items: services, total: services.length });
    let m;
    if (req.method === 'GET' && (m = path.match(/^\/api\/v1\/services\/([\w-]+)\/targets$/))) return json(200, { ok: true, targets: ['dbs_test', 'postgres'] });
    if (req.method === 'POST' && path === '/api/v1/requests') {
      const v = JSON.parse(body || '{}');
      if (!['read', 'read_write'].includes(v.accessType) || !v.targetDatabases?.length) return json(400, { error: 'invalid request input' });
      if (state.requests.some((r) => r.userId === me.userId && r.serviceInstanceId === v.serviceInstanceId && r.status === 'pending')) return json(409, { error: 'a pending request for this service already exists' });
      const r = { requestId: `req-${state.requests.length + 1}`, userId: me.userId, serviceInstanceId: v.serviceInstanceId, status: 'pending', requestType: 'developer', accessType: v.accessType, reason: v.reason, targetDatabases: v.targetDatabases, accessTtlHours: 8, createdAt: new Date().toISOString() };
      state.requests.unshift(r);
      return json(201, r);
    }
    if (req.method === 'GET' && path === '/api/v1/requests') return json(200, state.requests.filter((r) => r.userId === me.userId).map((r) => ({ ...enrich(r), provisioningLog: undefined })));
    if (req.method === 'GET' && path === '/api/v1/approvals') return json(200, state.requests.filter((r) => r.status === 'pending' && r.userId !== me.userId).map(enrich));
    if (req.method === 'GET' && path === '/api/v1/approvals/decided') {
      const mine = state.requests.filter((r) => r.reviewedBy === me.userId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
      return json(200, { items: mine.map(enrich), next: null });
    }
    if ((m = path.match(/^\/api\/v1\/requests\/([\w-]+)(?:\/(approve|reject|revoke))?$/))) {
      const r = state.requests.find((x) => x.requestId === m[1]);
      if (!r) return json(404, { error: 'request not found' });
      if (req.method === 'GET' && !m[2]) return json(200, enrich(r));
      if (m[2] === 'approve' || m[2] === 'reject') {
        if (r.userId === me.userId) return json(403, { error: 'cannot approve your own request' });
        r.status = m[2] === 'approve' ? 'approved' : 'rejected';
        r.reviewedBy = me.userId;
        r.reviewedAt = new Date().toISOString();
        if (m[2] === 'reject') r.rejectReason = JSON.parse(body || '{}').reason;
        return json(200, r);
      }
      if (m[2] === 'revoke') {
        r.status = 'revoked';
        return json(200, r);
      }
    }
    if (req.method === 'GET' && path === '/api/v1/credentials') {
      const r = state.requests.find((x) => x.requestId === url.searchParams.get('requestId'));
      if (!r || r.provisioningStatus !== 'provisioned') return json(200, []);
      return json(200, [{ credentialId: `cred-${r.requestId}`, accessRequestId: r.requestId, username: dbUser, credentialType: 'db_password', status: 'active', viewCount: state.reveals, maxViews: 5, expiresAt: r.expiresAt }]);
    }
    if (req.method === 'POST' && (m = path.match(/^\/api\/v1\/credentials\/([\w-]+)\/reveal$/))) {
      if (state.reveals >= 5) return json(429, { error: 'no reveals left' });
      state.reveals += 1;
      return json(200, { password: dbPassword, revealsRemaining: 5 - state.reveals });
    }
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const find = (pred) => state.requests.find(pred);
  return {
    url,
    state,
    /** The signed-in user's newest request. */
    mine: () => find((r) => r.userId === me.userId),
    /** Approve + start provisioning, then finish it (as the server's provisioning worker would). */
    approve(id) {
      const r = find((x) => x.requestId === id);
      r.status = 'approved';
      r.provisioningStatus = 'queued';
      r.provisioningLog = [{ ts: new Date().toISOString(), level: 'info', msg: 'creating database user' }];
    },
    provision(id, ttlSecs = 8 * 3600) {
      const r = find((x) => x.requestId === id);
      r.provisioningStatus = 'provisioned';
      r.expiresAt = Math.floor(Date.now() / 1000) + ttlSecs;
    },
    revoke(id) {
      find((x) => x.requestId === id).status = 'revoked';
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
