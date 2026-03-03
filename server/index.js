// server/index.js — Production-grade webhook listener for mass-scale GitHub App
// Designed for horizontal scaling behind a load balancer

const express = require('express');
const crypto = require('crypto');
const { createServer } = require('http');

// ── Configuration ──────────────────────────────────────────────────────
const APP_SECRET = process.env.GITHUB_APP_SECRET || '';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_PAYLOAD_SIZE = process.env.MAX_PAYLOAD_SIZE || '10mb';
const GRACEFUL_SHUTDOWN_TIMEOUT = parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT, 10) || 10000;

// ── Structured Logger ──────────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[LOG_LEVEL] ?? 2;

function log(level, message, meta = {}) {
  if ((LOG_LEVELS[level] ?? 2) > currentLevel) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    pid: process.pid,
    ...meta,
  };
  // SECURITY: never log secrets, tokens, or PEM keys
  const sanitized = JSON.stringify(entry, (key, value) => {
    if (['secret', 'token', 'key', 'password', 'authorization'].includes(key.toLowerCase())) {
      return '[REDACTED]';
    }
    return value;
  });
  process.stdout.write(sanitized + '\n');
}

// ── Signature Verification ─────────────────────────────────────────────
function verifySignature(req, res, buf) {
  const sig = req.headers['x-hub-signature-256'] || '';
  if (!APP_SECRET) {
    log('warn', 'GITHUB_APP_SECRET not set — signature verification disabled');
    return;
  }
  if (!sig) {
    throw new Error('Missing x-hub-signature-256 header');
  }
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(buf);
  const digest = 'sha256=' + hmac.digest('hex');
  if (sig.length !== digest.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest))) {
    log('error', 'Invalid webhook signature', { deliveryId: req.headers['x-github-delivery'] });
    throw new Error('Invalid signature');
  }
}

// ── Express App ────────────────────────────────────────────────────────
const app = express();

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.requestId = req.headers['x-github-delivery'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// JSON parser with signature verification
app.use(express.json({
  limit: MAX_PAYLOAD_SIZE,
  verify: verifySignature,
}));

// ── Webhook Handler ────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  const event = req.headers['x-github-event'];
  const deliveryId = req.requestId;

  log('info', 'Webhook received', { event, deliveryId });

  try {
    await handleEvent(event, req.body, deliveryId);
    const duration = Date.now() - startTime;
    log('info', 'Webhook processed', { event, deliveryId, durationMs: duration });
    res.status(200).json({ status: 'ok', deliveryId });
  } catch (err) {
    const duration = Date.now() - startTime;
    log('error', 'Webhook processing failed', {
      event,
      deliveryId,
      durationMs: duration,
      error: err.message,
    });
    res.status(500).json({ status: 'error', deliveryId, error: 'Internal processing error' });
  }
});

// ── Event Router ───────────────────────────────────────────────────────
async function handleEvent(event, payload, deliveryId) {
  switch (event) {
    case 'pull_request':
      return handlePullRequest(payload, deliveryId);
    case 'push':
      return handlePush(payload, deliveryId);
    case 'check_run':
      return handleCheckRun(payload, deliveryId);
    case 'check_suite':
      return handleCheckSuite(payload, deliveryId);
    case 'issues':
      return handleIssues(payload, deliveryId);
    case 'installation':
      return handleInstallation(payload, deliveryId);
    case 'ping':
      log('info', 'Ping received', { deliveryId, zen: payload.zen });
      return;
    default:
      log('debug', 'Unhandled event type', { event, deliveryId });
  }
}

// ── Event Handlers ─────────────────────────────────────────────────────
async function handlePullRequest(payload, deliveryId) {
  const { action, number } = payload;
  const pr = payload.pull_request;
  log('info', 'Pull request event', {
    deliveryId,
    action,
    prNumber: number,
    title: pr.title,
    author: pr.user?.login,
    base: pr.base?.ref,
    head: pr.head?.ref,
    draft: pr.draft,
  });

  // Extensibility: add batch orchestration triggers here
  if (action === 'opened' || action === 'synchronize') {
    log('info', 'PR ready for processing', {
      deliveryId,
      prNumber: number,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    });
  }
}

async function handlePush(payload, deliveryId) {
  const { ref, after, before, commits } = payload;
  log('info', 'Push event', {
    deliveryId,
    ref,
    headSha: after,
    beforeSha: before,
    commitCount: commits?.length ?? 0,
    pusher: payload.pusher?.name,
  });
}

async function handleCheckRun(payload, deliveryId) {
  const { action, check_run: checkRun } = payload;
  log('info', 'Check run event', {
    deliveryId,
    action,
    checkName: checkRun.name,
    status: checkRun.status,
    conclusion: checkRun.conclusion,
  });
}

async function handleCheckSuite(payload, deliveryId) {
  const { action, check_suite: suite } = payload;
  log('info', 'Check suite event', {
    deliveryId,
    action,
    status: suite.status,
    conclusion: suite.conclusion,
    headBranch: suite.head_branch,
  });
}

async function handleIssues(payload, deliveryId) {
  const { action, issue } = payload;
  log('info', 'Issue event', {
    deliveryId,
    action,
    issueNumber: issue.number,
    title: issue.title,
    author: issue.user?.login,
  });
}

async function handleInstallation(payload, deliveryId) {
  const { action, installation } = payload;
  log('info', 'Installation event', {
    deliveryId,
    action,
    installationId: installation.id,
    account: installation.account?.login,
    targetType: installation.target_type,
  });
}

// ── Health & Readiness ─────────────────────────────────────────────────
let isReady = true;

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get('/ready', (req, res) => {
  if (isReady) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({ ready: false, reason: 'shutting_down' });
  }
});

// Kubernetes / orchestrator metrics endpoint
app.get('/metrics', (req, res) => {
  const mem = process.memoryUsage();
  res.type('text/plain').send([
    `# HELP nodejs_heap_used_bytes Heap memory used`,
    `# TYPE nodejs_heap_used_bytes gauge`,
    `nodejs_heap_used_bytes ${mem.heapUsed}`,
    `# HELP nodejs_heap_total_bytes Total heap memory`,
    `# TYPE nodejs_heap_total_bytes gauge`,
    `nodejs_heap_total_bytes ${mem.heapTotal}`,
    `# HELP nodejs_rss_bytes Resident set size`,
    `# TYPE nodejs_rss_bytes gauge`,
    `nodejs_rss_bytes ${mem.rss}`,
    `# HELP process_uptime_seconds Process uptime`,
    `# TYPE process_uptime_seconds gauge`,
    `process_uptime_seconds ${process.uptime()}`,
  ].join('\n') + '\n');
});

// ── 404 handler ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ───────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log('error', 'Unhandled error', {
    requestId: req.requestId,
    error: err.message,
    path: req.path,
  });
  if (err.message === 'Invalid signature' || err.message?.includes('signature')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Server Startup with Graceful Shutdown ──────────────────────────────
const server = createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Webhook server started', { port: PORT, pid: process.pid, nodeVersion: process.version });
});

// Graceful shutdown for container orchestrators (K8s, ECS, etc.)
function gracefulShutdown(signal) {
  log('info', 'Shutdown signal received', { signal });
  isReady = false; // Stop accepting new work from load balancer

  server.close(() => {
    log('info', 'HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    log('warn', 'Forced shutdown after timeout');
    process.exit(1);
  }, GRACEFUL_SHUTDOWN_TIMEOUT);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { reason: String(reason) });
});

module.exports = { app, server };
