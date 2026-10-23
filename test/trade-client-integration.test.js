'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');

async function fixture() {
  const base = await authFixture();
  const application = createApplication({ repository: base.repository, clock: base.clock,
    resolveIdentity: async context => ({ openid: context.trustedSubject }) });
  const transport = openid => request => application.handle(request, { trustedSubject: openid });
  const buyer = createTradeClient({ clock: base.clock, send: transport('buyer-demo') });
  const owner = createTradeClient({ clock: base.clock, send: transport('owner-demo') });
  const staff = createTradeClient({ clock: base.clock, send: transport('staff-demo') });
  const input = { requestId: 'checkout-client-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 2 }] };
  return { ...base, application, transport, buyer, owner, staff, input };
}

test('本地调用链：客户端报价/下单/支付失败/成功/店主拒单闭环', async () => {
  const { buyer, owner, input, repository } = await fixture();
  const attempt = await buyer.prepareCheckout(input);
  assert.equal(attempt.quote.totalCents, 2500);
  const order = await attempt.submit();
  const failed = await buyer.orders.pay(order._id, { outcome: 'failure', attemptId: 'payment-client-001' });
  assert.equal(failed.paymentStatus, 'UNPAID');
  const paid = await buyer.orders.pay(order._id, { expectedVersion: failed.version });
  const session = await owner.staff.login(DEMO_PASSWORD);
  assert.equal(session.role, 'owner');
  const refund = await owner.orders.reject({ orderId: order._id, requestId: 'reject-client-001',
    expectedVersion: paid.version, reason: '演示无法备货' });
  assert.equal(refund.amountCents, 2500);
  const final = await buyer.orders.get(order._id);
  assert.equal(final.status, 'CANCELLED');
  assert.equal(final.paymentStatus, 'REFUNDED');
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
});

test('本地调用链：服务端创建已提交但响应丢失，原意图重试只创建一单', async () => {
  const { transport, clock, repository, input } = await fixture();
  let drop = true;
  const buyer = createTradeClient({ clock, send: async request => {
    const response = await transport('buyer-demo')(request);
    if (request.action === 'orders.create' && drop) { drop = false; throw new Error('RESPONSE_LOST_AFTER_COMMIT'); }
    return response;
  } });
  const attempt = await buyer.prepareCheckout(input);
  await assert.rejects(attempt.submit(), error => error.code === 'NETWORK_ERROR' && error.uncertain);
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
  const recovered = await attempt.retry();
  assert.equal(recovered.requestId, input.requestId);
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
});

test('本地调用链：事务提交失败后沿用原请求重试，库存和订单不残留', async () => {
  const { buyer, input, repository, transport, clock } = await fixture();
  // 在orders.create事务前注入失败；应用入口还有独立身份读取事务。
  let inject = true;
  const faultingBuyer = createTradeClient({ clock, send: async request => {
    if (request.action === 'orders.create' && inject) {
      inject = false;
      const original = repository.transaction.bind(repository);
      let reads = 0;
      repository.transaction = work => {
        reads += 1;
        if (reads === 2) { repository.failNextCommit = true; repository.transaction = original; }
        return original(work);
      };
    }
    return transport('buyer-demo')(request);
  } });
  const attempt = await faultingBuyer.prepareCheckout(input);
  await assert.rejects(attempt.submit(), error => error.code === 'INTERNAL_ERROR' && error.uncertain);
  assert.equal(Object.keys(repository.snapshot().orders || {}).length, 0);
  assert.equal(repository.snapshot().products.bread.reserved, 0);
  const recovered = await attempt.retry();
  assert.equal((await buyer.orders.get(recovered._id)).version, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
});

test('本地调用链：报价后调价必须重新人工确认，不能自动接受新价格', async () => {
  const { buyer, input, repository } = await fixture();
  const attempt = await buyer.prepareCheckout(input);
  await repository.transaction(async tx => {
    await tx.set('products', 'bread', { ...await tx.get('products', 'bread'), priceCents: 1500 });
  });
  await assert.rejects(attempt.submit(), error => error.code === 'PRICE_CHANGED' && error.recovery === 'requote');
  assert.equal(Object.keys(repository.snapshot().orders || {}).length, 0);
  const confirmed = await buyer.prepareCheckout({ ...input, requestId: 'checkout-client-002' });
  assert.equal(confirmed.quote.totalCents, 3000);
  assert.equal((await confirmed.submit()).amounts.totalCents, 3000);
});

test('本地调用链：客户端会话和服务端三角色/订单归属同时生效', async () => {
  const { buyer, staff, owner, input } = await fixture();
  const order = await (await buyer.prepareCheckout(input)).submit();
  await owner.staff.login(DEMO_PASSWORD);
  await staff.staff.login(DEMO_PASSWORD);
  await assert.rejects(owner.orders.get(order._id), error => error.code === 'FORBIDDEN');
  await assert.rejects(staff.inventory.adjust({ productId: 'bread', requestId: 'adjust-client-001',
    expectedVersion: 1, onHand: 20, reason: '越权测试' }), error => error.code === 'FORBIDDEN');
  await owner.staff.setAccess({ targetOpenid: 'staff-demo', enabled: false });
  await assert.rejects(staff.identity.me(), error => error.code === 'UNAUTHENTICATED');
  assert.equal(staff.getSession(), null);
});

test('本地调用链：注销清客户端与服务端会话，旧令牌不再可用', async () => {
  const { owner, repository, application } = await fixture();
  await owner.staff.login(DEMO_PASSWORD);
  assert.equal(Object.values(repository.snapshot().staff_sessions)[0].revokedAt, null);
  assert.deepEqual(await owner.staff.logout(), { cleared: true, remoteRevoked: true });
  assert.equal(owner.getSession(), null);
  assert.equal(Object.values(repository.snapshot().staff_sessions)[0].revokedAt, 1000000);
  assert.equal((await application.handle({ action: 'identity.me', data: {} },
    { trustedSubject: 'owner-demo' })).data.role, 'customer');
});
