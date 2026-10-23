'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradeClient } = require('../services/trade-client');

const input = () => ({ requestId: 'checkout-intent-001', deliveryType: 'pickup',
  items: [{ productId: 'bread', quantity: 2 }], remark: '演示备注' });
const quote = { totalCents: 2500, subtotalCents: 2500, shippingCents: 0,
  items: [{ productId: 'bread', quantity: 2, unitPriceCents: 1250, lineTotalCents: 2500 }] };
const success = data => ({ success: true, data });
function created(data) { return success({ _id: 'order-a', requestId: data.requestId,
  amounts: { totalCents: data.expectedTotalCents }, version: 1 }); }

test('结算意图：展示服务端报价，冻结请求ID/金额/商品/备注，不随页面输入改变', async () => {
  const requests = [];
  const client = createTradeClient({ send: async request => {
    requests.push(request);
    return request.action === 'orders.quote' ? success(quote) : created(request.data);
  } });
  const selection = input();
  const attempt = await client.prepareCheckout(selection);
  selection.items[0].quantity = 20;
  selection.remark = '之后改写';
  assert.equal(attempt.quote.totalCents, 2500);
  assert.equal(attempt.payload.expectedTotalCents, 2500);
  assert.throws(() => { attempt.payload.items[0].quantity = 3; }, TypeError);
  await attempt.submit();
  assert.equal(requests[1].data.items[0].quantity, 2);
  assert.equal(requests[1].data.remark, '演示备注');
});

test('结算意图：十次同时点击共用一次创建请求，成功后调用返回副本', async () => {
  let creates = 0;
  const client = createTradeClient({ send: async request => {
    if (request.action === 'orders.quote') return success(quote);
    creates += 1;
    return created(request.data);
  } });
  const attempt = await client.prepareCheckout(input());
  const results = await Promise.all(Array.from({ length: 10 }, () => attempt.submit()));
  results[0].amounts.totalCents = 1;
  assert.equal(results[1].amounts.totalCents, 2500);
  assert.equal((await attempt.retry()).amounts.totalCents, 2500);
  assert.equal(creates, 1);
});

test('结算意图：响应丢失后只做显式重试，参数不变、不重新报价', async () => {
  const sent = [];
  let first = true;
  const client = createTradeClient({ send: async request => {
    sent.push(request);
    if (request.action === 'orders.quote') return success(quote);
    if (first) { first = false; throw new Error('response-lost'); }
    return created(request.data);
  } });
  const attempt = await client.prepareCheckout(input());
  await assert.rejects(attempt.submit(), error => error.code === 'NETWORK_ERROR' && error.uncertain);
  assert.equal(sent.length, 2);
  await attempt.retry();
  assert.deepEqual(sent[1], sent[2]);
  assert.equal(sent.filter(row => row.action === 'orders.quote').length, 1);
});

test('结算意图：价格变化交给用户重新确认，不自动改价或换请求ID', async () => {
  let calls = 0;
  const client = createTradeClient({ send: async request => {
    calls += 1;
    return request.action === 'orders.quote' ? success(quote)
      : { success: false, error: { code: 'PRICE_CHANGED' } };
  } });
  const attempt = await client.prepareCheckout(input());
  await assert.rejects(attempt.submit(), error => error.code === 'PRICE_CHANGED' && error.recovery === 'requote');
  assert.equal(calls, 2);
  assert.equal(attempt.payload.requestId, 'checkout-intent-001');
  assert.equal(attempt.payload.expectedTotalCents, 2500);
});

test('结算意图：身份切换后旧意图不可提交或返回缓存订单', async () => {
  let calls = 0;
  const client = createTradeClient({ send: async request => {
    calls += 1;
    return request.action === 'orders.quote' ? success(quote) : created(request.data);
  } });
  const attempt = await client.prepareCheckout(input());
  await attempt.submit();
  client.clearSession();
  await assert.rejects(attempt.submit(), error => error.code === 'SESSION_CHANGED');
  assert.equal(calls, 2);
});

test('结算意图：报价期间身份变化时不保留报价', async () => {
  let resolve;
  const client = createTradeClient({ send: () => new Promise(ok => { resolve = ok; }) });
  const pending = client.prepareCheckout(input());
  client.clearSession();
  resolve(success(quote));
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
});

test('结算意图：提交期间身份变化时不把旧订单展示为新身份的订单', async () => {
  let resolve;
  let payload;
  const client = createTradeClient({ send: async request => {
    if (request.action === 'orders.quote') return success(quote);
    payload = request.data;
    return new Promise(ok => { resolve = ok; });
  } });
  const attempt = await client.prepareCheckout(input());
  const pending = attempt.submit();
  client.clearSession();
  resolve(created(payload));
  await assert.rejects(pending, error => error.code === 'SESSION_CHANGED' && error.uncertain);
});

test('结算意图：无效请求ID、报价或订单响应不能被标记成功', async () => {
  let badQuote = true;
  const client = createTradeClient({ send: async request => {
    if (request.action === 'orders.quote') return success(badQuote ? { totalCents: 1.5 } : quote);
    return success({ _id: 'order-a', requestId: 'wrong-request', amounts: { totalCents: 1 } });
  } });
  await assert.rejects(client.prepareCheckout({ ...input(), requestId: 'short' }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(client.prepareCheckout(input()), error => error.code === 'PROTOCOL_ERROR');
  badQuote = false;
  const attempt = await client.prepareCheckout(input());
  await assert.rejects(attempt.submit(), error => error.code === 'PROTOCOL_ERROR' && error.uncertain);
});
