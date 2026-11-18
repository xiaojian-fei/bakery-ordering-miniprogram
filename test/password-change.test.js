'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/index');
const { loadConfig } = require('../server/config');

const OWNER_PASSWORD = 'owner-pass-123456';
const OWNER_NEW_PASSWORD = 'owner-pass-654321';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakery-pwd-'));
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
  async request(method, pathname, body) {
    const response = await fetch(this.base + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; ') } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  changePassword(currentPassword, newPassword) {
    return this.request('POST', '/api/password', { currentPassword, newPassword });
  }
  action(action, data = {}) {
    return this.request('POST', '/api/action', { action, data });
  }
  session() { return this.request('GET', '/api/session'); }
}

async function register(base, username, password) {
  const session = new Session(base);
  const result = await session.request('POST', '/api/register', { username, password });
  assert.equal(result.status, 201, '注册失败：' + JSON.stringify(result.body));
  return session;
}

test('修改密码：未登录时拒绝', async () => {
  const app = await boot();
  try {
    const response = await new Session(app.base).changePassword('old-pass-123', 'new-pass-123');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  } finally { await app.close(); }
});

test('修改密码：当前密码错误时不做任何改动', async () => {
  const app = await boot();
  try {
    const alice = await register(app.base, 'alice', 'alicepass123');
    const wrong = await alice.changePassword('not-my-password', 'alicepass456');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'AUTH_FAILED');

    // 旧密码仍然可用，说明失败请求没有写库
    const again = new Session(app.base);
    const login = await again.request('POST', '/api/login', { username: 'alice', password: 'alicepass123' });
    assert.equal(login.status, 200);
  } finally { await app.close(); }
});

test('修改密码：新密码长度不足或与当前相同都会被拒绝', async () => {
  const app = await boot();
  try {
    const alice = await register(app.base, 'alice', 'alicepass123');
    const short = await alice.changePassword('alicepass123', 'short');
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'INVALID_PASSWORD');

    const same = await alice.changePassword('alicepass123', 'alicepass123');
    assert.equal(same.status, 400);
    assert.equal(same.body.error.code, 'INVALID_PASSWORD');
  } finally { await app.close(); }
});

test('修改密码：顾客改密后保持当前会话，其它设备会话被撤销', async () => {
  const app = await boot();
  try {
    const laptop = await register(app.base, 'alice', 'alicepass123');
    const phone = new Session(app.base);
    await phone.request('POST', '/api/login', { username: 'alice', password: 'alicepass123' });
    assert.equal((await phone.session()).body.authenticated, true);

    const changed = await laptop.changePassword('alicepass123', 'alicepass456');
    assert.equal(changed.status, 200);
    assert.equal(changed.body.changed, true);
    assert.equal(changed.body.reauthRequired, false, '顾客改密后不需要重新登录');
    assert.ok(changed.body.revokedSessions >= 1, '其它设备的会话应被撤销');

    assert.equal((await laptop.session()).body.authenticated, true, '当前会话仍然有效');
    assert.equal((await phone.session()).body.authenticated, false, '另一设备被登出');

    // 旧密码失效、新密码可用
    const stale = await new Session(app.base).request('POST', '/api/login',
      { username: 'alice', password: 'alicepass123' });
    assert.equal(stale.status, 401);
    const fresh = await new Session(app.base).request('POST', '/api/login',
      { username: 'alice', password: 'alicepass456' });
    assert.equal(fresh.status, 200);
  } finally { await app.close(); }
});

test('修改密码：员工改密后必须重新登录，旧员工会话立即失效', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    const login = await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    assert.equal(login.body.staffRole, 'owner');
    assert.equal((await owner.action('orders.list', { manage: true })).status, 200);

    const changed = await owner.changePassword(OWNER_PASSWORD, OWNER_NEW_PASSWORD);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.reauthRequired, true, '员工改密后需要重新登录');

    // Cookie 已在响应里被清掉，员工动作不再可用
    const afterChange = await owner.action('orders.list', { manage: true });
    assert.equal(afterChange.status, 401);

    // 旧密码不能登录，新密码可以，且能重新取得员工角色
    const stale = await new Session(app.base).request('POST', '/api/login',
      { username: 'owner', password: OWNER_PASSWORD });
    assert.equal(stale.status, 401);
    const fresh = new Session(app.base);
    const relogin = await fresh.request('POST', '/api/login', { username: 'owner', password: OWNER_NEW_PASSWORD });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.body.staffRole, 'owner');
    assert.equal((await fresh.action('orders.list', { manage: true })).status, 200);
  } finally { await app.close(); }
});

test('修改密码：员工当前密码错误同样被拒绝', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    const wrong = await owner.changePassword('wrong-password-x', 'another-pass-123');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'AUTH_FAILED');
  } finally { await app.close(); }
});

test('修改密码：写入审计事件，但不记录密码本身', async () => {
  const app = await boot();
  try {
    const alice = await register(app.base, 'alice', 'alicepass123');
    await alice.changePassword('alicepass123', 'alicepass456');
    const events = Object.values(app.repository.snapshot().auth_events || {})
      .filter(event => event.action === 'PASSWORD_CHANGED_SELF');
    assert.equal(events.length, 1);
    assert.equal(events[0].role, 'customer');
    const log = JSON.stringify(events[0]);
    assert.ok(!log.includes('alicepass'), '审计事件不能包含密码明文');
    assert.ok(!log.includes('scrypt$'), '审计事件不能包含密码哈希');
  } finally { await app.close(); }
});

test('修改密码：员工账号不能把密码改到短于 12 位', async () => {
  const app = await boot();
  try {
    const owner = new Session(app.base);
    await owner.request('POST', '/api/login', { username: 'owner', password: OWNER_PASSWORD });
    const short = await owner.changePassword(OWNER_PASSWORD, 'shortpass1');  // 10 位，员工要求 12 位
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'INVALID_PASSWORD');
  } finally { await app.close(); }
});