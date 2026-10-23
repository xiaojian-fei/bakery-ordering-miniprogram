'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradeClient, TradeApiError } = require('../services/trade-client');

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const success = data => ({ success: true, data });
const failure = code => ({ success: false, error: { code, message: 'raw-sensitive-server-detail' } });
const login = (token = tokenA) => success({ token, role: 'owner', expiresAt: 10000 });
const code = expected => error => error instanceof TradeApiError && error.code === expected;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('客户端：显式业务动作和字段白名单，身份/角色/伪造令牌不进入data', async () => {
  const sent = [];
  const client = createTradeClient({ send: async request => { sent.push(request); return success({ ok: true }); } });
  await client.orders.create({ requestId: 'checkout-001', items: [{ productId: 'bread', quantity: 1 }],
    deliveryType: 'pickup', totalPrice: 0.01, openid: 'someone', role: 'owner', staffToken: 'forged', actor: {} });
  assert.deepEqual(sent[0], { action: 'orders.create', data: { requestId: 'checkout-001',
    items: [{ productId: 'bread', quantity: 1 }], deliveryType: 'pickup' } });
  assert.equal(client.call, undefined);
  assert.equal(client.orders.expire, undefined);
});

test('客户端：口令登录仅返回会话摘要，令牌只在内部内存及发送封装中', async () => {
  const sent = [];
  const client = createTradeClient({ clock: () => 1000, send: async request => {
    sent.push(request);
    return request.action === 'staff.login' ? login() : success({ changed: true });
  } });
  assert.deepEqual(await client.staff.login('DemoOnly-Password'), { role: 'owner', expiresAt: 10000 });
  assert.ok(!JSON.stringify(client.getSession()).includes(tokenA));
  await client.inventory.adjust({ requestId: 'adjust-001', productId: 'bread', onHand: 10, expectedVersion: 1, reason: '补货' });
  assert.equal(sent[0].staffToken, undefined);
  assert.equal(sent[1].staffToken, tokenA);
  assert.equal(sent[1].data.staffToken, undefined);
});

test('客户端：未登录与本地到期的管理操作要求登录，不发送管理请求', async () => {
  let now = 1000;
  const sent = [];
  const client = createTradeClient({ clock: () => now, send: async request => {
    sent.push(request);
    return request.action === 'staff.login' ? login() : success({ role: 'customer' });
  } });
  await assert.rejects(client.inventory.adjust({}), code('UNAUTHENTICATED'));
  await client.staff.login('DemoOnly-Password');
  now = 10000;
  await assert.rejects(client.orders.reject({}), code('UNAUTHENTICATED'));
  assert.equal(client.getSession(), null);
  await client.identity.me();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].staffToken, undefined);
});

test('客户端：服务端会话失效时清本地会话，不自动降级重发原操作', async () => {
  let calls = 0;
  const client = createTradeClient({ clock: () => 1000, send: async request => {
    calls += 1;
    return request.action === 'staff.login' ? login() : failure('UNAUTHENTICATED');
  } });
  await client.staff.login('DemoOnly-Password');
  await assert.rejects(client.inventory.adjust({}), code('UNAUTHENTICATED'));
  assert.equal(calls, 2);
  assert.equal(client.getSession(), null);
});

test('客户端：旧请求迟到的认证失败不能清除新登录会话', async () => {
  const pending = deferred();
  let logins = 0;
  const sent = [];
  const client = createTradeClient({ clock: () => 1000, send: async request => {
    sent.push(request);
    if (request.action === 'staff.login') return login(++logins === 1 ? tokenA : tokenB);
    if (request.action === 'identity.me') return pending.promise;
    return success({ changed: true });
  } });
  await client.staff.login('DemoOnly-Password');
  const oldRequest = client.identity.me();
  await client.staff.login('DemoOnly-Password');
  pending.resolve(failure('UNAUTHENTICATED'));
  await assert.rejects(oldRequest, code('UNAUTHENTICATED'));
  await client.inventory.adjust({});
  assert.equal(sent.at(-1).staffToken, tokenB);
});

test('客户端：注销发生在登录返回前时，迟到登录不能恢复本地会话', async () => {
  const pending = deferred();
  const client = createTradeClient({ clock: () => 1000, send: () => pending.promise });
  const signingIn = client.staff.login('DemoOnly-Password');
  assert.deepEqual(await client.staff.logout(), { cleared: true, remoteRevoked: false });
  pending.resolve(login());
  await assert.rejects(signingIn, code('SESSION_CHANGED'));
  assert.equal(client.getSession(), null);
});

test('客户端：注销网络失败也清本地会话，但明确提示服务端结果未确认', async () => {
  const client = createTradeClient({ clock: () => 1000, send: async request => {
    if (request.action === 'staff.login') return login();
    throw new Error('sensitive-token-' + tokenA);
  } });
  await client.staff.login('DemoOnly-Password');
  await assert.rejects(client.staff.logout(), error => {
    assert.equal(error.uncertain, true);
    assert.ok(!error.message.includes(tokenA));
    return error.code === 'NETWORK_ERROR';
  });
  assert.equal(client.getSession(), null);
});

test('客户端：网络/内部错误保留结果未知标记，业务错误给出本地恢复指引', async () => {
  let mode = 'network';
  let calls = 0;
  const client = createTradeClient({ send: async () => {
    calls += 1;
    if (mode === 'network') throw new Error('raw-sensitive-detail');
    return failure(mode);
  } });
  await assert.rejects(client.orders.create({}), error => error.code === 'NETWORK_ERROR' && error.uncertain);
  await assert.rejects(client.orders.get('order-a'), error => error.code === 'NETWORK_ERROR' && !error.uncertain);
  mode = 'INTERNAL_ERROR';
  await assert.rejects(client.orders.pay('order-a'), error => error.code === mode && error.uncertain);
  mode = 'PRICE_CHANGED';
  await assert.rejects(client.orders.create({}), error => {
    assert.equal(error.recovery, 'requote');
    assert.equal(error.uncertain, false);
    assert.ok(!error.message.includes('raw-sensitive'));
    return error.code === mode;
  });
  assert.equal(calls, 4);
});

test('客户端：畸形响应不当成功，未知业务码不显示服务端原文', async () => {
  let response;
  const client = createTradeClient({ send: async () => response });
  for (const value of [null, [], { success: 'yes' }, { success: true }, failure('bad code')]) {
    response = value;
    await assert.rejects(client.orders.create({}), error => error.code === 'PROTOCOL_ERROR' && error.uncertain);
  }
  response = failure('FUTURE_BUSINESS_CODE');
  await assert.rejects(client.orders.get('order-a'), error => {
    assert.ok(!error.message.includes('raw-sensitive'));
    assert.equal(error.recovery, 'review');
    return error.code === 'FUTURE_BUSINESS_CODE';
  });
});

test('客户端：拒绝畸形登录响应，不能凭任意角色或令牌格式建立会话', async () => {
  let data;
  const client = createTradeClient({ clock: () => 1000, send: async () => success(data) });
  for (const value of [{ token: 'bad', role: 'owner', expiresAt: 10000 },
    { token: tokenA, role: 'system', expiresAt: 10000 }, { token: tokenA, role: 'owner', expiresAt: 1000 }]) {
    data = value;
    await assert.rejects(client.staff.login('DemoOnly-Password'), code('PROTOCOL_ERROR'));
    assert.equal(client.getSession(), null);
  }
});

test('客户端：非法JSON输入在发送前拒绝，嵌套输入在调用时复制', async () => {
  const seen = [];
  const client = createTradeClient({ send: async request => { seen.push(request); return success({}); } });
  const cycle = {}; cycle.self = cycle;
  for (const input of [null, [], { items: cycle }, { items: [undefined] }, { expectedTotalCents: NaN }]) {
    await assert.rejects(client.orders.create(input), code('INVALID_REQUEST'));
  }
  assert.equal(seen.length, 0);
  const input = { items: [{ productId: 'bread', quantity: 1 }], deliveryType: 'pickup' };
  const promise = client.orders.quote(input);
  input.items[0].quantity = 9;
  await promise;
  assert.equal(seen[0].data.items[0].quantity, 1);
});

test('客户端：所有公开业务门面映射到固定动作，支付参数错误不被悄悄丢弃', async () => {
  const seen = [];
  const client = createTradeClient({ clock: () => 1000, send: async request => {
    seen.push(request);
    return request.action === 'staff.login' ? login() : success(request.action === 'staff.logout' ? { revoked: true } : {});
  } });
  await client.staff.login('DemoOnly-Password');
  await client.staff.setAccess({ targetOpenid: 'staff-a', enabled: true, role: 'owner' });
  await client.staff.setPassword({ targetOpenid: 'staff-a', password: 'DemoOnly-New-Password' });
  await client.orders.pay('order-a', { success: false, openid: 'forged' });
  await client.orders.cancel('order-a', { expectedVersion: 1 });
  await client.orders.reject({ orderId: 'order-a', reason: '无法备货', requestId: 'reject-001', expectedVersion: 2 });
  await client.refunds.executeApproved({ afterSaleId: 'after-a', expectedOrderVersion: 2 });
  await client.staff.logout();
  assert.deepEqual(seen.map(row => row.action), ['staff.login', 'staff.setAccess', 'staff.setPassword',
    'orders.pay', 'orders.cancel', 'orders.reject', 'refunds.executeApproved', 'staff.logout']);
  assert.equal(seen[1].data.role, undefined);
  assert.equal(seen[3].data.success, false);
});
