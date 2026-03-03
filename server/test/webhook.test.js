// server/test/webhook.test.js — Basic webhook endpoint tests
// Run with: node --test server/test/webhook.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const TEST_PORT = 3999;
let server;

before(async () => {
  process.env.PORT = String(TEST_PORT);
  process.env.LOG_LEVEL = 'error'; // quiet during tests
  const { server: srv } = require('../index.js');
  server = srv;
  // Wait for server to be ready
  await new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/health`);
        if (res.ok) { clearInterval(interval); resolve(); }
      } catch { /* not ready yet */ }
    }, 100);
  });
});

after(() => {
  server.close();
});

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Health endpoint', () => {
  it('GET /health returns 200', async () => {
    const res = await makeRequest('/health');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.status, 'ok');
    assert.ok(data.uptime >= 0);
    assert.ok(data.pid > 0);
  });
});

describe('Readiness endpoint', () => {
  it('GET /ready returns 200 with ready=true', async () => {
    const res = await makeRequest('/ready');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ready, true);
  });
});

describe('Metrics endpoint', () => {
  it('GET /metrics returns Prometheus-style metrics', async () => {
    const res = await makeRequest('/metrics');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('nodejs_heap_used_bytes'));
    assert.ok(res.body.includes('process_uptime_seconds'));
  });
});

describe('Webhook endpoint', () => {
  it('POST /webhook accepts ping event', async () => {
    const payload = JSON.stringify({ zen: 'test', hook_id: 1 });
    const res = await makeRequest('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': 'test-delivery-001',
      },
      body: payload,
    });
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.status, 'ok');
  });

  it('POST /webhook accepts pull_request event', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      number: 42,
      pull_request: {
        number: 42,
        title: 'Test PR',
        user: { login: 'testuser' },
        base: { ref: 'main' },
        head: { ref: 'feature' },
        draft: false,
        changed_files: 3,
        additions: 10,
        deletions: 5,
      },
    });
    const res = await makeRequest('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'test-delivery-002',
      },
      body: payload,
    });
    assert.strictEqual(res.status, 200);
  });

  it('POST /webhook accepts push event', async () => {
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'abc123',
      before: 'def456',
      commits: [{ id: 'abc123', message: 'test' }],
      pusher: { name: 'testuser' },
    });
    const res = await makeRequest('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'test-delivery-003',
      },
      body: payload,
    });
    assert.strictEqual(res.status, 200);
  });
});

describe('404 handling', () => {
  it('GET /nonexistent returns 404', async () => {
    const res = await makeRequest('/nonexistent');
    assert.strictEqual(res.status, 404);
  });
});

describe('Request tracing', () => {
  it('Response includes X-Request-Id header', async () => {
    const res = await makeRequest('/health');
    assert.ok(res.headers['x-request-id']);
  });
});
