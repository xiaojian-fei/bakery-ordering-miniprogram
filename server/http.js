'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { BusinessError } = require('../core/domain/errors');
const { requireRole } = require('../core/domain/auth');
const { parseCookies } = require('./sessions');
const { buildClientBundle } = require('./bundle');

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
});

const IMAGE_TYPES = Object.freeze({
  'image/png': { ext: 'png', test: buffer => buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 },
  'image/jpeg': { ext: 'jpg', test: buffer => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/webp': {
    ext: 'webp',
    test: buffer => buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF'
      && buffer.toString('latin1', 8, 12) === 'WEBP'
  }
});

const UPLOAD_NAME = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const STATUS_BY_CODE = Object.freeze({
  INVALID_REQUEST: 400,
  INVALID_PASSWORD: 400,
  INVALID_CURSOR: 400,
  AUTH_FAILED: 401,
  AUTH_LOCKED: 423,
  AUTH_RETRY: 409,
  UNAUTHENTICATED: 401,
  SESSION_CHANGED: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  USERNAME_TAKEN: 409,
  NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE: 409,
  TOO_MANY_ATTEMPTS: 429,
  REQUEST_TOO_LARGE: 413,
  REPORT_TOO_LARGE: 413
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const statusFor = code => STATUS_BY_CODE[code] || 400;

function sendJson(res, status, payload, cookies = []) {
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function securityHeaders(config) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'Cache-Control': 'no-store',
    ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=15552000' } : {})
  };
}

function expectedOrigin(req, config) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return null;
  return (config.secureCookies ? 'https://' : 'http://') + host;
}

async function readJson(req, limit) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED', '请求必须是 JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'REQUEST_TOO_LARGE', '请求体超过限制');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_JSON', '请求体必须是对象');
  return body;
}

function createHttpServer({ config, application, accounts, sessions, repository, jobs = null, log = () => {} }) {
  const bundlePromise = buildClientBundle(config.root);
  const buckets = new Map();

  function throttle(req, bucket, max, windowMs) {
    const key = bucket + ':' + (req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      return;
    }
    entry.count += 1;
    if (entry.count > max) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
  }

  async function context(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.cookieName];
    const session = await sessions.resolve(token);
    return { cookies, token, session, staffToken: cookies[config.staffCookieName] };
  }

  async function requireSession(req) {
    const ctx = await context(req);
    if (!ctx.session) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录');
    return ctx;
  }

  async function requireOwner(req) {
    const ctx = await requireSession(req);
    if (!ctx.staffToken) throw new HttpError(403, 'FORBIDDEN', '需要店主会话');
    const actor = await accounts.resolveStaffActor(ctx.session.openid, ctx.staffToken);
    requireRole(actor, ['owner']);
    return { ...ctx, actor };
  }

  async function serveStatic(res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.includes('..') || relative.includes('\\') || path.isAbsolute(relative)) return false;
    const file = path.join(config.webDir, relative);
    if (!file.startsWith(config.webDir + path.sep)) return false;
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (!type) return false;
    let data;
    try {
      data = await fs.readFile(file);
    } catch (_) {
      return false;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
    return true;
  }

  async function serveUpload(res, pathname) {
    const name = pathname.slice('/uploads/'.length);
    if (!UPLOAD_NAME.test(name)) return false;
    let data;
    try {
      data = await fs.readFile(path.join(config.uploadDir, name));
    } catch (_) {
      return false;
    }
    const type = CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(data);
    return true;
  }

  async function handleGet(req, res, pathname) {
    if (pathname === '/healthz') {
      const info = repository.info;
      return sendJson(res, 200, { ok: true, database: path.basename(config.dbFile), schemaVersion: info.schemaVersion,
        collections: info.collections, indexes: info.indexes });
    }
    if (pathname === '/api/client.js') {
      const bundle = await bundlePromise;
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(bundle);
    }
    if (pathname === '/api/session') {
      const { session, staffToken } = await context(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      const user = await repository.transaction(tx => tx.get('users', session.openid));
      let staffRole = null;
      if (staffToken) {
        try {
          const actor = await accounts.resolveStaffActor(session.openid, staffToken);
          staffRole = actor.role;
        } catch (_) { /* 员工令牌已失效，按顾客身份继续 */ }
      }
      return sendJson(res, 200, {
        authenticated: true, openid: session.openid, username: user?.username || '',
        role: user?.role || 'customer', staffRole, expiresAt: session.expiresAt
      });
    }
    if (pathname === '/api/staff') {
      await requireOwner(req);
      return sendJson(res, 200, { staff: await accounts.listStaff() });
    }
    if (pathname.startsWith('/uploads/')) {
      if (await serveUpload(res, pathname)) return undefined;
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (await serveStatic(res, pathname)) return undefined;
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  async function handlePost(req, res, pathname) {
    if (pathname === '/api/register') {
      throttle(req, 'register', config.authRateLimit, config.authRateWindowMs);
      const body = await readJson(req, config.maxBodyBytes);
      const account = await accounts.register({ username: body.username, password: body.password });
      const session = await sessions.create(account.openid, { userAgent: req.headers['user-agent'] || '' });
      return sendJson(res, 201, { authenticated: true, openid: account.openid, username: account.username,
        role: account.role, staffRole: null }, [sessions.cookie(session.token, session.expiresAt)]);
    }
    if (pathname === '/api/login') {
      throttle(req, 'login', config.authRateLimit, config.authRateWindowMs);
      const body = await readJson(req, config.maxBodyBytes);
      const result = await accounts.login({
        username: body.username, password: body.password, userAgent: req.headers['user-agent'] || ''
      });
      const cookies = [sessions.cookie(result.session.token, result.session.expiresAt)];
      if (result.staffToken) cookies.push(sessions.staffCookie(result.staffToken, result.staffExpiresAt));
      return sendJson(res, 200, {
        authenticated: true, openid: result.openid, username: result.username,
        role: result.role, staffRole: result.staffToken ? result.role : null
      }, cookies);
    }
    if (pathname === '/api/logout') {
      const ctx = await context(req);
      await accounts.logout({ token: ctx.token, staffToken: ctx.staffToken, openid: ctx.session?.openid });
      return sendJson(res, 200, { authenticated: false },
        [sessions.clearCookie(), sessions.clearStaffCookie()]);
    }
    if (pathname === '/api/action') {
      const ctx = await requireSession(req);
      const body = await readJson(req, config.maxBodyBytes);
      const bodyToken = typeof body.staffToken === 'string' && body.staffToken ? body.staffToken : undefined;
      const staffToken = bodyToken || ctx.staffToken || undefined;
      const response = await application.handle(
        { action: body.action, data: body.data, staffToken },
        { openid: ctx.session.openid, userAgent: req.headers['user-agent'] || '' }
      );
      if (!response.success) return sendJson(res, statusFor(response.error.code), response);
      // 员工令牌只通过 HttpOnly Cookie 下发，不回显给页面脚本。
      if (body.action === 'staff.login') {
        const { token, role, expiresAt } = response.data;
        return sendJson(res, 200, { success: true, data: { role, expiresAt } },
          [sessions.staffCookie(token, expiresAt)]);
      }
      if (body.action === 'staff.logout') {
        return sendJson(res, 200, response, [sessions.clearStaffCookie()]);
      }
      return sendJson(res, 200, response);
    }
    if (pathname === '/api/upload') {
      const { session, staffToken } = await requireOwner(req);
      const body = await readJson(req, Math.ceil(config.maxUploadBytes * 1.4) + 8192);
      const image = IMAGE_TYPES[body.contentType];
      if (!image) throw new HttpError(415, 'UNSUPPORTED_IMAGE', '只支持 PNG、JPEG、WebP');
      if (typeof body.data !== 'string' || body.data.length === 0) throw new HttpError(400, 'INVALID_REQUEST', '缺少图片数据');
      const buffer = Buffer.from(body.data, 'base64');
      if (buffer.length === 0 || buffer.length > config.maxUploadBytes) {
        throw new HttpError(413, 'REQUEST_TOO_LARGE', '图片超过大小限制');
      }
      if (!image.test(buffer)) throw new HttpError(415, 'UNSUPPORTED_IMAGE', '图片内容与声明的类型不符');
      await fs.mkdir(config.uploadDir, { recursive: true });
      const name = randomBytes(16).toString('hex') + '.' + image.ext;
      await fs.writeFile(path.join(config.uploadDir, name), buffer);
      log(`图片上传：${session.openid} -> ${name}（${buffer.length} 字节）`);
      return sendJson(res, 201, { url: '/uploads/' + name, bytes: buffer.length });
    }
    if (pathname === '/api/staff') {
      const { actor } = await requireOwner(req);
      const body = await readJson(req, config.maxBodyBytes);
      const created = await accounts.createStaff(actor, { username: body.username, password: body.password });
      return sendJson(res, 201, { staff: created });
    }
    if (pathname === '/api/staff/access') {
      const { actor } = await requireOwner(req);
      const body = await readJson(req, config.maxBodyBytes);
      const result = await accounts.setStaffAccess(actor, { username: body.username, enabled: body.enabled });
      return sendJson(res, 200, { result });
    }
    if (pathname === '/api/jobs/run') {
      await requireOwner(req);
      if (!jobs) return sendJson(res, 200, { skipped: true });
      return sendJson(res, 200, { expiry: await jobs.expiry.run(), notification: await jobs.notification.run({ limit: 20 }) });
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  async function route(req, res) {
    for (const [name, value] of Object.entries(securityHeaders(config))) res.setHeader(name, value);
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (_) {
      return sendJson(res, 400, { error: { code: 'INVALID_PATH', message: '路径不合法' } });
    }
    const envelopePath = pathname === '/api/action';
    const fail = (status, code, message) => sendJson(res, status, envelopePath
      ? { success: false, error: { code, message } }
      : { error: { code, message } });
    if (pathname.includes('\u0000')) return fail(400, 'INVALID_PATH', '路径不合法');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const expected = expectedOrigin(req, config);
      if (origin && expected && origin !== expected) return fail(403, 'ORIGIN_MISMATCH', '请求来源不匹配');
      if (req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'CROSS_SITE_BLOCKED', '拒绝跨站请求');
    }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') return await handleGet(req, res, pathname);
      if (req.method === 'POST') return await handlePost(req, res, pathname);
      res.setHeader('Allow', 'GET, HEAD, POST');
      return fail(405, 'METHOD_NOT_ALLOWED', '不支持该请求方法');
    } catch (error) {
      if (res.headersSent) return res.end();
      // 只对业务动作接口使用客户端 SDK 约定的 {success,error} 信封，
      // 其余接口统一用 {error:{code,message}}，两种形状都不再混用扁平字符串。
      const envelope = envelopePath;
      if (error instanceof HttpError) {
        return sendJson(res, error.status, envelope
          ? { success: false, error: { code: error.code, message: error.message } }
          : { error: { code: error.code, message: error.message } });
      }
      if (error instanceof BusinessError) {
        return sendJson(res, statusFor(error.code), envelope
          ? { success: false, error: { code: error.code, message: error.message } }
          : { error: { code: error.code, message: error.message } });
      }
      log('请求处理失败：' + (error && error.message ? error.message : String(error)));
      return sendJson(res, 500, envelope
        ? { success: false, error: { code: 'INTERNAL_ERROR', message: '服务暂不可用' } }
        : { error: { code: 'INTERNAL_ERROR', message: '服务暂不可用' } });
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      log('未捕获的请求异常：' + (error && error.message ? error.message : String(error)));
      if (!res.headersSent) sendJson(res, 500, { error: 'SERVER_ERROR' });
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

module.exports = { createHttpServer, IMAGE_TYPES, UPLOAD_NAME };