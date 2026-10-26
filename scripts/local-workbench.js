'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createLocalDemo } = require('./local-demo-fixture');
const { NotificationJob } = require('../cloudfunctions/api/jobs/notification-job');
const { OrderExpiryJob } = require('../cloudfunctions/api/jobs/order-expiry-job');

async function createWorkbench() {
  const demo = await createLocalDemo();
  const root = path.resolve(__dirname, '..');
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', content: await fs.readFile(path.join(root, 'preview/workbench.html'), 'utf8') }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', content: await fs.readFile(path.join(root, 'preview/workbench.js'), 'utf8') }]
  ]);
  const modules = await Promise.all(['trade-errors', 'checkout-attempt', 'trade-client'].map(async name =>
    JSON.stringify('./' + name) + ': function(module, require) {\n' + await fs.readFile(path.join(root, 'services', name + '.js'), 'utf8') + '\n}'));
  const bundle = '(function(){const definitions={' + modules.join(',')
    + '};const cache={};function require(id){if(!cache[id]){const module={exports:{}};cache[id]=module;definitions[id](module,require);}return cache[id].exports;}window.TradeClient=require("./trade-client");})();';
  assets.set('/client.js', { type: 'text/javascript; charset=utf-8', content: bundle });
  const sessions = new Map();
  const notificationJob = new NotificationJob({ repository: demo.repository, clock: demo.clock,
    send: async () => ({ delivered: true }) });
  const expiryJob = new OrderExpiryJob({ clock: demo.clock,
    findCandidates: options => demo.repository.findExpiredOrders(options), expireOrder: demo.application.expireOrder });
  const server = http.createServer(async (req, res) => {
    const base = 'http://127.0.0.1:' + server.address().port;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== '127.0.0.1:' + server.address().port) return json(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
      if (req.method === 'POST' && req.headers.origin !== base) return json(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
      let sessionId = /(?:^|;\s*)demo_sid=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!sessionId || !sessions.has(sessionId)) {
        if (sessions.size >= 128) return json(503, { error: 'TOO_MANY_DEMO_SESSIONS' });
        sessionId = randomBytes(24).toString('hex');
        sessions.set(sessionId, { identity: 'buyer' });
        res.setHeader('Set-Cookie', 'demo_sid=' + sessionId + '; Path=/; HttpOnly; SameSite=Strict');
      }
      const session = sessions.get(sessionId);
      if (req.method === 'GET' && assets.has(req.url)) {
        const asset = assets.get(req.url); res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.content); return;
      }
      if (req.method === 'GET' && req.url === '/demo/state') return json(200, { identity: session.identity, now: demo.clock(), mode: 'LOCAL_DEMO' });
      if (req.method !== 'POST') return json(404, { error: 'NOT_FOUND' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON_REQUIRED' });
      if (Number(req.headers['content-length']) > 65536) { req.resume(); return json(413, { error: 'REQUEST_TOO_LARGE' }); }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return json(413, { error: 'REQUEST_TOO_LARGE' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return json(400, { error: 'INVALID_JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'INVALID_JSON' });
      if (req.url === '/demo/identity') {
        if (!['buyer', 'staff', 'owner'].includes(body.identity)) return json(400, { error: 'UNKNOWN_DEMO_IDENTITY' });
        session.identity = body.identity;
        return json(200, { identity: session.identity, now: demo.clock() });
      }
      if (req.url === '/api') return json(200, await demo.handle(body, session.identity));
      if (req.url === '/demo/dispatch' || req.url === '/demo/advance') {
        if (session.identity !== 'owner') return json(403, { error: 'DEMO_OWNER_REQUIRED' });
        if (req.url === '/demo/dispatch') return json(200, await notificationJob.run({ limit: 50 }));
        demo.advance(15 * 60000);
        return json(200, { now: demo.clock(), expiry: await expiryJob.run() });
      }
      return json(404, { error: 'NOT_FOUND' });
    } catch (_) { if (!res.headersSent) json(500, { error: 'DEMO_SERVER_ERROR' }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, demo };
}

if (require.main === module) {
  createWorkbench().then(({ server }) => {
    const port = Number(process.env.LOCAL_DEMO_PORT || 3218);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_LOCAL_PORT');
    server.on('error', error => { console.error('本地工作台启动失败：', error.code || 'LOCAL_SERVER_ERROR'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log('本地演示工作台：http://127.0.0.1:' + port);
      console.log('虚构身份、内存数据、模拟支付；不连接云开发或外部通知。停止进程后数据清空。');
    });
  }).catch(() => { console.error('本地工作台初始化失败'); process.exitCode = 1; });
}
module.exports = { createWorkbench };
