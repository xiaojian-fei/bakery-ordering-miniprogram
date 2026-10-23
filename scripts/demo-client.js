'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createTradeClient } = require('../services/trade-client');
const { createApplication } = require('../cloudfunctions/api/application');
const { hashPassword } = require('../cloudfunctions/api/domain/passwords');
const { MemoryRepository } = require('../test/support/memory-repository');

async function main() {
  const password = randomBytes(24).toString('hex');
  const repository = new MemoryRepository({
    users: { 'owner-demo': { openid: 'owner-demo', role: 'owner', active: true, authVersion: 0 } },
    staff_credentials: { 'owner-demo': { passwordHash: await hashPassword(password),
      passwordVersion: 1, failedAttempts: 0, lockedUntil: 0 } },
    products: { bread: { _id: 'bread', name: '演示司康', priceCents: 1250,
      isOnSale: true, onHand: 10, reserved: 0, inventoryVersion: 0 } }
  });
  const application = createApplication({ repository,
    resolveIdentity: async context => ({ openid: context.demoSubject }) });
  let dropCreateResponse = true;
  const localTransport = demoSubject => async request => {
    // 假身份绑定仅用于此内存演示，不是可部署的身份认证。
    const result = await application.handle(request, { demoSubject });
    if (demoSubject === 'buyer-demo' && request.action === 'orders.create' && dropCreateResponse) {
      dropCreateResponse = false;
      throw new Error('DEMO_RESPONSE_LOST_AFTER_COMMIT');
    }
    return result;
  };
  const buyer = createTradeClient({ send: localTransport('buyer-demo') });
  const owner = createTradeClient({ send: localTransport('owner-demo') });
  console.log('客户端联调演示：纯内存、虚构身份、模拟支付，不访问微信或外网。');
  const attempt = await buyer.prepareCheckout({ requestId: 'demo-client-checkout-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }] });
  console.log('1. 展示可信报价：', attempt.quote.totalCents, '分。');
  try { await attempt.submit(); }
  catch (error) {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.uncertain, true);
    console.log('2. 模拟创建已提交、响应丢失：', error.code, '；保留原请求待确认重试。');
  }
  const order = await attempt.retry();
  assert.equal(Object.keys(repository.snapshot().orders).length, 1);
  assert.equal(repository.snapshot().products.bread.reserved, 2);
  console.log('3. 原请求重试恢复订单：数据库仍只有1单，预留2件。');
  const paid = await buyer.orders.pay(order._id);
  await owner.staff.login(password);
  const refund = await owner.orders.reject({ orderId: paid._id, requestId: 'demo-client-reject-001',
    expectedVersion: paid.version, reason: '演示无法备货' });
  console.log('4. 模拟支付后，店主拒单退款：', refund.amountCents, '分。');
  const result = await buyer.orders.get(order._id);
  assert.equal(result.paymentStatus, 'REFUNDED');
  assert.equal(repository.snapshot().products.bread.onHand, 10);
  console.log('5. 顾客刷新：', result.status, '/', result.paymentStatus, '，库存恢复到10件。');
  const logout = await owner.staff.logout();
  assert.equal(logout.remoteRevoked, true);
  console.log('6. 店主注销：本地会话清除，服务端会话已撤销。');
  console.log('演示完成；口令与令牌均不输出，进程退出后数据清空。');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
