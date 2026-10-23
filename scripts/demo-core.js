'use strict';
const { randomBytes } = require('node:crypto');
const { createApplication } = require('../cloudfunctions/api/application');
const { hashPassword } = require('../cloudfunctions/api/domain/passwords');
const { MemoryRepository } = require('../test/support/memory-repository');
const { OrderExpiryJob } = require('../cloudfunctions/api/jobs/order-expiry-job');

async function main() {
  // 纯内存演示：随机口令仅存在于本进程，不是可部署的默认管理员。
  const password = randomBytes(24).toString('hex');
  const passwordHash = await hashPassword(password);
  const repository = new MemoryRepository({
    users: { 'owner-demo': { openid: 'owner-demo', role: 'owner', active: true, authVersion: 0 } },
    staff_credentials: { 'owner-demo': { passwordHash, passwordVersion: 1, failedAttempts: 0, lockedUntil: 0 } },
    products: { bread: { _id: 'bread', name: '演示司康', priceCents: 1250,
      onHand: 10, reserved: 0, inventoryVersion: 0, isOnSale: true } }
  });
  let now = Date.now();
  const clock = () => now;
  const application = createApplication({ repository, clock,
    resolveIdentity: async context => ({ openid: context.demoIdentity }) });
  async function call(action, data, identity = 'buyer-demo', staffToken) {
    const result = await application.handle({ action, data, staffToken }, { demoIdentity: identity });
    if (!result.success) throw new Error(result.error.code + ': ' + result.error.message);
    return result.data;
  }
  console.log('本地交易核心演示：虚构身份、内存存储、模拟支付；不连接微信或外部服务。');
  const session = await call('staff.login', { password }, 'owner-demo');
  console.log('1. 店主完成口令认证，会话令牌不输出。');
  const order = await call('orders.create', { requestId: 'demo-checkout-001', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }], totalPrice: 0.01 });
  console.log('2. 创建订单：服务端金额', order.amounts.totalCents, '分，状态', order.status);
  const failed = await call('orders.pay', { orderId: order._id, outcome: 'failure', attemptId: 'demo-attempt-001' });
  console.log('3. 模拟支付失败：', failed.status, '，库存保持预留。');
  const paid = await call('orders.pay', { orderId: order._id });
  console.log('4. 模拟支付成功：', paid.status, '，实物库存', repository.snapshot().products.bread.onHand);
  // 只模拟C未来审核服务的输出，不把这一行当作售后流程已开发完成。
  await repository.transaction(tx => tx.set('after_sales', 'demo-after-sale', {
    _id: 'demo-after-sale', orderId: order._id, ownerOpenid: 'buyer-demo', status: 'APPROVED',
    approvedBy: 'owner-demo', approvedAt: Date.now(), reason: '演示整单退款'
  }));
  const refund = await call('refunds.executeApproved', { afterSaleId: 'demo-after-sale' }, 'owner-demo', session.token);
  console.log('5. 已审批售后执行整单模拟退款：', refund.amountCents, '分，恢复库存', refund.restocked);
  const product = repository.snapshot().products.bread;
  const adjusted = await call('inventory.adjust', { productId: 'bread', requestId: 'demo-adjust-001',
    onHand: 12, expectedVersion: product.inventoryVersion, reason: '演示补货' }, 'owner-demo', session.token);
  console.log('6. 店主调整库存：', adjusted.before, '→', adjusted.after, '，版本', adjusted.inventoryVersion);
  const denied = await application.handle({ action: 'inventory.adjust', role: 'owner', data: {
    productId: 'bread', requestId: 'demo-forged-001', onHand: 999,
    expectedVersion: adjusted.inventoryVersion, reason: '伪造角色测试'
  } }, { demoIdentity: 'buyer-demo' });
  if (denied.success || denied.error.code !== 'FORBIDDEN') throw new Error('角色边界校验未通过');
  console.log('7. 顾客伪造店主角色：', denied.error.code);
  const rejectedOrder = await call('orders.create', { requestId: 'demo-checkout-reject', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] });
  const rejectPaid = await call('orders.pay', { orderId: rejectedOrder._id });
  const rejected = await call('orders.reject', { orderId: rejectPaid._id, requestId: 'demo-reject-001',
    expectedVersion: rejectPaid.version, reason: '演示无法备货' }, 'owner-demo', session.token);
  console.log('8. 店主拒单并原子完成模拟退款：', rejected.amountCents, '分，恢复库存', rejected.restocked);
  const unpaid = await call('orders.create', { requestId: 'demo-checkout-expire', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] });
  now = unpaid.expiresAt;
  const expiryJob = new OrderExpiryJob({ clock,
    findCandidates: options => repository.findExpiredOrders(options), expireOrder: application.expireOrder });
  const expired = await expiryJob.run({ batchSize: 2 });
  console.log('9. 批量超时处理：到期', expired.expired, '单，失败', expired.failed,
    '单，剩余预留', repository.snapshot().products.bread.reserved);
  console.log('演示完成；进程结束后内存数据清空。');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
