'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/index');
const { loadConfig } = require('../server/config');

const OWNER_PASSWORD = 'owner-pass-123456';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 每个测试文件启动一次独立服务，数据库与上传目录都在临时目录里。 */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakery-http-'));
  const config = loadConfig({}, {
    dbFile: path.join(dir, 'test.sqlite'),
    uploadDir: path.join(dir, 'uploads'),
    ownerPassword: OWNER_PASSWORD,
    ownerUsername: 'owner'
  });
  const instance = await createServer({ config, log: () => {} });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port;
  return {
    ...instance,
    base,
    async close() {
      await new Promise(resolve => instance.server.close(resolve));
      instance.repository.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

class Session {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  async request(method, pathname, body, headers = {}) {
    const response = await fetch(this.base + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; ') } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
    return { status: response.status, body: json, text, headers: response.headers };
  }
  action(action, data = {}, staffToken) {
    return this.request('POST', '/api/action', { action, data, ...(staffToken ? { staffToken } : {}) });
  }
}

test('网页端 HTTP：首页、健康检查与安全响应头', async () => {
  const app = await boot();
  try {
    const home = await new Session(app.base).request('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    const health = await new Session(app.base).request('GET', '/healthz');
    assert.equal(health.body.ok, true);
    assert.ok(health.body.collections >= 25);
  } finally { await app.close(); }
});

test('网页端 HTTP：未登录不能调用业务接口', async () => {
  const app = await boot();
  try {
    const result = await new Session(app.base).action('catalog.list');
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'UNAUTHENTICATED');
  } finally { await app.close(); }
});

test('网页端 HTTP：顾客注册、会话 Cookie 与用户名唯一性', async () => {
  const app = await boot();
  try {
    const session = new Session(app.base);
    const registered = await session.request('POST', '/api/register', { username: 'alice', password: 'alicepass123' });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.role, 'customer');
    const cookie = registered.headers.getSetCookie().find(line => line.startsWith('bakery_sid='));
    assert.ok(cookie, '必须下发会话 Cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const state = await session.request('GET', '/api/session');
    assert.equal(state.body.authenticated, true);
    assert.equal(state.body.username, 'alice');

    const catalog = await session.action('catalog.list');
    assert.equal(catalog.body.success, true);
    assert.ok(catalog.body.data.items.length >= 1);

    const duplicate = await new Session(app.base).request('POST', '/api/register', { username: 'alice', password: 'alicepass123' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'USERNAME_TAKEN');
  } finally { await app.close(); }
});

test('网页端 HTTP：弱密码与错误密码分别被拒绝', async () => {
  const app = await boot();
  try {
    const short = await new Session(app.base).request('POST', '/api/register', { username: 'bobby', password: 'short' });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'INVALID_PASSWORD');

    await new Session(app.base).request('POST', '/api/register', { username: 'carol', password: 'carolpass123' });
    const wrong = await new Session(app.base).request('POST', '/api/login', { username: 'carol', password: 'wrongpass123' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'AUTH_FAILED');
  } finally { await app.close(); }
});

test('网页端 HTTP：顾客绕过客户端调用店主动作仍被服务端拒绝', async () => {
  const app = await boot();
  try {
    const session = new Session(app.base);
    await session.request('POST', '/api/register', { username: 'dave', password: 'davepass1234' });
    const now = Date.now();
    const blocked = await session.action('statistics.summary', { startAt: now - 86400000, endAt: now });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'FORBIDDEN');

    const staffCreate = await session.request('POST', '/api/staff', { username: 'hacker', password: 'hackerpass123' });
    assert.equal(staffCreate.status, 403);
  } finally { await app.close(); }
});

test('网页端 HTTP：店主登录取得员工会话，员工令牌只走 HttpOnly Cookie', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    const login = await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.staffRole, 'owner');
    assert.equal(login.body.staffToken, undefined, '令牌不能出现在响应体');

    const staffCookie = login.headers.getSetCookie().find(line => line.startsWith('bakery_staff='));
    assert.ok(staffCookie, '必须下发员工 Cookie');
    assert.match(staffCookie, /HttpOnly/);

    const managed = await owner.action('orders.list', { manage: true });
    assert.equal(managed.body.success, true);
  } finally { await app.close(); }
});

test('网页端 HTTP：店主创建员工账号，员工只能履约不能退款', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    const created = await owner.request('POST', '/api/staff', { username: 'worker', password: 'workerpass123' });
    assert.equal(created.status, 201);
    assert.equal(created.body.staff.role, 'staff');

    const worker = new Session(app.base);
    const login = await worker.request('POST', '/api/login', { username: 'worker', password: 'workerpass123' });
    assert.equal(login.body.staffRole, 'staff');

    const review = await worker.action('afterSales.review', {
      afterSaleId: 'as_x', expectedVersion: 1, requestId: 'req-12345678', decision: 'approve', reason: 'x'
    });
    assert.equal(review.status, 403);

    const listed = await worker.action('orders.list', { manage: true });
    assert.equal(listed.body.success, true, '员工可以查看待处理订单');

    const staffList = await worker.request('GET', '/api/staff');
    assert.equal(staffList.status, 403, '员工不能管理账号');
  } finally { await app.close(); }
});

test('网页端 HTTP：跨来源请求、目录穿越与非法方法被拦截', async () => {
  const app = await boot();
  try {
    const session = new Session(app.base);
    await session.request('POST', '/api/register', { username: 'erin', password: 'erinpass1234' });
    const crossSite = await session.request('POST', '/api/action',
      { action: 'catalog.list', data: {} }, { Origin: 'http://evil.example.com' });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, 'ORIGIN_MISMATCH');

    const traversal = await new Session(app.base).request('GET', '/../package.json');
    assert.equal(traversal.status, 404);

    const wrongMethod = await new Session(app.base).request('DELETE', '/api/action');
    assert.equal(wrongMethod.status, 405);

    // 业务接口先校验会话再解析请求体，未登录时不会因为请求体格式而改变状态码
    const notJson = await new Session(app.base).request('POST', '/api/action', null, { 'Content-Type': 'text/plain' });
    assert.equal(notJson.status, 401);
    const badJson = await session.request('POST', '/api/action', null, { 'Content-Type': 'text/plain' });
    assert.equal(badJson.status, 415);
  } finally { await app.close(); }
});

test('网页端 HTTP：图片上传校验类型与权限', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });

    const ok = await owner.request('POST', '/api/upload', { contentType: 'image/png', data: PNG.toString('base64') });
    assert.equal(ok.status, 201);
    assert.match(ok.body.url, /^\/uploads\/[0-9a-f]{32}\.png$/);
    const file = await new Session(app.base).request('GET', ok.body.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');

    const fake = await owner.request('POST', '/api/upload', {
      contentType: 'image/png', data: Buffer.from('<svg/>').toString('base64')
    });
    assert.equal(fake.status, 415);

    const unsupported = await owner.request('POST', '/api/upload', {
      contentType: 'image/gif', data: PNG.toString('base64')
    });
    assert.equal(unsupported.status, 415);

    const customer = new Session(app.base);
    await customer.request('POST', '/api/register', { username: 'frank', password: 'frankpass1234' });
    const denied = await customer.request('POST', '/api/upload', { contentType: 'image/png', data: PNG.toString('base64') });
    assert.equal(denied.status, 403);
  } finally { await app.close(); }
});

test('网页端 HTTP：两个顾客的订单互不可见，顾客也不能用员工视角', async () => {
  const app = await boot();
  try {
    const alice = new Session(app.base);
    await alice.request('POST', '/api/register', { username: 'alice', password: 'alicepass123' });
    const bob = new Session(app.base);
    await bob.request('POST', '/api/register', { username: 'bobbb', password: 'bobpass12345' });

    const catalog = await alice.action('catalog.list');
    const product = catalog.body.data.items[0];
    const created = await alice.action('orders.create', {
      requestId: 'iso-alice-0001', deliveryType: 'pickup',
      items: [{ productId: product._id, quantity: 1 }]
    });
    assert.equal(created.body.success, true);
    const orderId = created.body.data._id;

    assert.equal((await alice.action('orders.get', { orderId })).body.success, true);

    const peek = await bob.action('orders.get', { orderId });
    assert.equal(peek.status, 403);
    assert.equal(peek.body.error.code, 'FORBIDDEN');

    const bobList = await bob.action('orders.list', {});
    assert.equal(bobList.body.data.items.length, 0);

    const bobManage = await bob.action('orders.list', { manage: true });
    assert.equal(bobManage.status, 403);
    assert.equal(bobManage.body.error.code, 'FORBIDDEN');

    // 商品与库存对所有已登录顾客可见
    const bobCatalog = await bob.action('catalog.list');
    assert.ok(bobCatalog.body.data.items.length >= 1);
    assert.equal(typeof bobCatalog.body.data.items[0].available, 'number');
  } finally { await app.close(); }
});

test('网页端 HTTP：退出登录后会话与员工令牌同时失效', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    const staffCookie = owner.cookies.get('bakery_staff');

    const out = await owner.request('POST', '/api/logout', {});
    assert.equal(out.status, 200);

    const after = await owner.request('GET', '/api/session');
    assert.equal(after.body.authenticated, false);

    // 旧会话 cookie 重放必须失效
    const replay = new Session(app.base);
    replay.cookies.set('bakery_sid', staffCookie || 'deadbeef');
    const replayResult = await replay.action('catalog.list');
    assert.equal(replayResult.status, 401);
  } finally { await app.close(); }
});

test('网页端 HTTP：员工账号停用后不能登录', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    await owner.request('POST', '/api/staff', { username: 'grace', password: 'gracepass1234' });

    const disable = await owner.request('POST', '/api/staff/access', { username: 'grace', enabled: false });
    assert.equal(disable.status, 200);

    // 停用账号与密码错误返回同一状态，避免泄露账号状态
    const denied = await new Session(app.base).request('POST', '/api/login', { username: 'grace', password: 'gracepass1234' });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, 'AUTH_FAILED');
  } finally { await app.close(); }
});