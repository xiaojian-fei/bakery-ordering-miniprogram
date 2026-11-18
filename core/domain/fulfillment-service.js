'use strict';
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { ensure } = require('./errors');
const { requireRole, requireOwner } = require('./auth');
const { nextStatus, STATUS } = require('./order-state');
const { writeOrderEvent } = require('./transaction-log');
const { id, text, version, once } = require('./service-utils');

class FulfillmentService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }

  async act(actor, action, input) {
    requireRole(actor, ['staff', 'owner']);
    ensure(['accept', 'ship', 'readyForPickup', 'complete'].includes(action), 'INVALID_ACTION', '未知履约动作');
    const normalized = { orderId: id(input.orderId), expectedVersion: version(input.expectedVersion, 1) };
    if (action === 'ship') {
      normalized.carrier = text(input.carrier, '承运方', 60);
      normalized.trackingNo = text(input.trackingNo, '运单号', 80);
      ensure(/^[A-Za-z0-9_-]{4,80}$/.test(normalized.trackingNo), 'INVALID_REQUEST', '运单号格式不合法');
    }
    if (action === 'complete') normalized.pickupCode = input.pickupCode ?? null;
    // 在事务外生成，事务重试不产生多个不同核销码，也不发送通知。
    const generatedCode = action === 'readyForPickup' ? randomBytes(6).toString('hex').toUpperCase() : null;
    return this.repository.transaction(tx => once(tx, actor, 'fulfill_' + action, input.requestId, normalized, async () => {
      const order = await tx.get('orders', normalized.orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      ensure(order.paymentStatus === 'PAID', 'INVALID_STATE', '仅能履约尚未退款的已支付订单');
      ensure(order.version === normalized.expectedVersion, 'VERSION_CONFLICT', '订单已更新，请刷新');
      const link = await tx.get('after_sale_links', order._id);
      const afterSale = link ? await tx.get('after_sales', link.afterSaleId) : null;
      ensure(afterSale?.status !== 'APPROVED', 'AFTER_SALE_PENDING', '订单售后已批准，等待退款处理');
      const pickup = action === 'complete' && order.deliveryType === 'pickup'
        ? await tx.get('pickup_codes', order._id) : null;
      const now = this.clock();
      const status = nextStatus(order, action, actor, now);
      if (action === 'complete') ensure((order.deliveryType === 'pickup' && order.status === STATUS.READY_FOR_PICKUP)
        || (order.deliveryType === 'delivery' && order.status === STATUS.SHIPPING), 'INVALID_DELIVERY', '订单履约路径不匹配');
      if (action === 'complete' && order.deliveryType === 'pickup') {
        ensure(pickup && pickup.usedAt === null && typeof normalized.pickupCode === 'string'
          && typeof pickup.code === 'string' && /^[0-9A-F]{12}$/.test(pickup.code)
          && /^[0-9A-F]{12}$/.test(normalized.pickupCode)
          && timingSafeEqual(Buffer.from(normalized.pickupCode), Buffer.from(pickup.code)),
        'INVALID_PICKUP_CODE', '自取核销码不正确或已使用');
      }
      const previousStatus = order.status;
      order.status = status; order.version += 1; order.updatedAt = now;
      if (action === 'accept') order.acceptedAt = now;
      if (action === 'ship') {
        order.shippedAt = now;
        order.fulfillment = { carrier: normalized.carrier, trackingNo: normalized.trackingNo, trackingMode: 'MANUAL' };
      }
      if (action === 'readyForPickup') order.readyAt = now;
      if (action === 'complete') order.completedAt = now;
      if (generatedCode) await tx.set('pickup_codes', order._id,
        { orderId: order._id, ownerOpenid: order.ownerOpenid, code: generatedCode, usedAt: null });
      if (pickup) await tx.set('pickup_codes', order._id, { ...pickup, usedAt: now });
      await tx.set('orders', order._id, order);
      await writeOrderEvent(tx, order, actor, action, previousStatus, now,
        action === 'ship' ? { carrier: normalized.carrier, trackingNo: normalized.trackingNo } : {});
      return order;
    }));
  }

  async pickupCode(actor, orderId) {
    id(orderId);
    return this.repository.transaction(async tx => {
      const order = await tx.get('orders', orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在'); requireOwner(actor, order);
      ensure(order.status === STATUS.READY_FOR_PICKUP && order.paymentStatus === 'PAID', 'INVALID_STATE', '订单当前不可自取核销');
      const pickup = await tx.get('pickup_codes', orderId);
      ensure(pickup && pickup.usedAt === null, 'INVALID_STATE', '核销码不存在或已使用');
      return { code: pickup.code };
    });
  }
}

module.exports = { FulfillmentService };
