'use strict';
const assert = require('node:assert/strict');
const { createLocalDemo } = require('./local-demo-fixture');
const { NotificationJob } = require('../cloudfunctions/api/jobs/notification-job');

async function main() {
  const demo = await createLocalDemo();
  const buyer = await demo.client('buyer'), staff = await demo.client('staff'), owner = await demo.client('owner');
  console.log('全组本地流程演示：虚构数据、内存事务、模拟支付和测试发送器，不连接云端。');
  await buyer.addresses.save({ addressId: 'demo-home', requestId: 'demo-address-001', expectedVersion: 0,
    name: '测试顾客', phone: '00000000000', province: '内蒙古', city: '测试市', district: '测试区', detail: '虚构地址', makeDefault: true });
  const cart = await buyer.cart.setLine({ productId: 'bread', quantity: 2, expectedVersion: 0, requestId: 'demo-cart-001' });
  const attempt = await buyer.prepareCheckout({ requestId: 'demo-delivery-001', deliveryType: 'delivery', addressId: 'demo-home', items: cart.items });
  let delivery = await attempt.submit();
  await buyer.cart.clear({ expectedVersion: cart.version, requestId: 'demo-cart-clear-001' });
  delivery = await buyer.orders.pay(delivery._id);
  for (const action of ['accept', 'ship', 'complete']) delivery = await staff.fulfillment[action]({
    orderId: delivery._id, expectedVersion: delivery.version, requestId: 'demo-delivery-' + action,
    carrier: '测试承运方', trackingNo: 'DEMO-DELIVERY-001' });
  assert.equal(delivery.status, 'COMPLETED');
  console.log('1. 配送：商品→默认地址→购物车→报价3500分→模拟付款→接单→发货→完成。');
  let pickup = await (await buyer.prepareCheckout({ requestId: 'demo-pickup-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 1 }] })).submit();
  pickup = await buyer.orders.pay(pickup._id);
  for (const action of ['accept', 'readyForPickup']) pickup = await staff.fulfillment[action]({
    orderId: pickup._id, expectedVersion: pickup.version, requestId: 'demo-pickup-' + action });
  const code = await buyer.orders.pickupCode(pickup._id);
  pickup = await staff.fulfillment.complete({ orderId: pickup._id, expectedVersion: pickup.version,
    requestId: 'demo-pickup-complete', pickupCode: code.code });
  assert.equal(pickup.status, 'COMPLETED');
  console.log('2. 自取：报价1250分→模拟付款→接单→备好→顾客取码→店员核销；不输出核销码。');
  let returned = await (await buyer.prepareCheckout({ requestId: 'demo-aftersale-001', deliveryType: 'pickup', items: [{ productId: 'bread', quantity: 2 }] })).submit();
  returned = await buyer.orders.pay(returned._id);
  const after = await buyer.afterSales.apply({ orderId: returned._id, requestId: 'demo-apply-001', reason: '演示售后' });
  await owner.afterSales.review({ afterSaleId: after._id, expectedVersion: 1, requestId: 'demo-review-001', decision: 'approve', reason: '同意模拟退款' });
  await owner.refunds.executeApproved({ afterSaleId: after._id });
  assert.equal((await buyer.afterSales.get(after._id)).status, 'REFUNDED');
  console.log('3. 售后：顾客真实调用申请→店主批准→整单模拟退款2500分，恢复未接单库存。');
  const summary = await owner.statistics.summary({ startAt: demo.clock() - 86400000, endAt: demo.clock() + 1 });
  assert.equal(summary.grossCents, 7250); assert.equal(summary.refundCents, 2500); assert.equal(summary.netCents, 4750);
  assert.equal(summary.completedOrderCount, 2); assert.equal(summary.productSales[0].quantity, 3);
  console.log('4. 对账：成交7250分，退款2500分，净额4750分，有效完成2单、销量3件。');
  const notifications = new NotificationJob({ repository: demo.repository, clock: demo.clock,
    send: async () => ({ delivered: true }) });
  const sent = await notifications.run({ limit: 50 });
  assert.equal(sent.failed, 0);
  console.log('5. 通知：测试发送器处理', sent.delivered, '个事件；未发出外部消息。');
  console.log('演示完成；进程结束后数据清空。');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
