'use strict';
const { createHash } = require('node:crypto');
const { ensure } = require('./errors');
const { requireRole } = require('./auth');
const { validId, requireMoney } = require('./pricing');
const { STATUS } = require('./order-state');
const { writeOrderEvent, writeInventoryMovement, writeAfterSaleEvent } = require('./transaction-log');
const { validateInventory, bumpInventoryVersion } = require('./inventory');

// 整单模拟退款的原子操作。售后申请、审核页面和审核流程由C负责。
// APPROVED 记录必须来自受保护的服务端审核，不能由客户端直接写入。
class RefundService {
  constructor(repository, { clock = Date.now } = {}) {
    ensure(repository && typeof repository.transaction === 'function', 'INVALID_CONFIG', '缺少事务适配器');
    this.repository = repository;
    this.clock = clock;
  }

  async refundApproved(actor, afterSaleId, { expectedOrderVersion } = {}) {
    requireRole(actor, ['owner']);
    ensure(validId(afterSaleId), 'INVALID_REQUEST', '售后ID不合法');
    if (expectedOrderVersion !== undefined) ensure(Number.isSafeInteger(expectedOrderVersion) && expectedOrderVersion >= 1,
      'INVALID_REQUEST', '订单版本不合法');
    return this.repository.transaction(async tx => {
      const afterSale = await tx.get('after_sales', afterSaleId);
      ensure(afterSale && validId(afterSale.orderId), 'AFTER_SALE_NOT_FOUND', '售后记录不存在或不完整');
      const order = await tx.get('orders', afterSale.orderId);
      ensure(order && order.ownerOpenid === afterSale.ownerOpenid, 'INVALID_AFTER_SALE', '售后与订单归属不一致');
      const refundId = 'refund_' + order._id;
      const existing = await tx.get('refunds', refundId);
      if (existing) {
        ensure(existing.afterSaleId === afterSaleId, 'ALREADY_REFUNDED', '该订单已通过其他流程完成整单退款');
        ensure(afterSale.status === 'REFUNDED' && order.paymentStatus === 'REFUNDED'
          && existing.status === 'SUCCEEDED', 'INVALID_AFTER_SALE', '退款记录状态不一致');
        return existing;
      }
      ensure(afterSale.status === 'APPROVED' && typeof afterSale.approvedBy === 'string' && afterSale.approvedBy
        && Number.isSafeInteger(afterSale.approvedAt), 'AFTER_SALE_NOT_APPROVED', '售后尚未通过服务端审核');
      ensure(typeof afterSale.reason === 'string' && afterSale.reason.trim() && afterSale.reason.length <= 200,
        'INVALID_AFTER_SALE', '售后原因不完整');
      if (expectedOrderVersion !== undefined) ensure(order.version === expectedOrderVersion, 'VERSION_CONFLICT', '订单已更新，请重新审核');
      const refund = await this.#executeRefund(tx, actor, order, { source: 'AFTER_SALE', afterSaleId,
        reason: afterSale.reason.trim(), action: 'refund', cancelReason: 'AFTER_SALE_REFUND' });
      afterSale.status = 'REFUNDED';
      afterSale.refundId = refund._id;
      afterSale.refundedAt = refund.createdAt;
      afterSale.version = (afterSale.version ?? 0) + 1;
      await tx.set('after_sales', afterSaleId, afterSale);
      await writeAfterSaleEvent(tx, afterSale, actor, 'REFUNDED', refund.createdAt, { amountCents: refund.amountCents });
      return refund;
    });
  }

  // A提供拒单退款原子操作，C的商家工作台调用；不伪造一条顾客售后申请。
  async rejectOrder(actor, input) {
    requireRole(actor, ['owner']);
    ensure(input && validId(input.orderId) && validId(input.requestId) && input.requestId.length >= 8,
      'INVALID_REQUEST', '拒单需要有效订单ID和8～80位requestId');
    ensure(typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 200,
      'INVALID_REQUEST', '拒单原因需为1～200字');
    ensure(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 1,
      'INVALID_REQUEST', '拒单必须提供当前订单版本');
    const reason = input.reason.trim();
    const hash = value => createHash('sha256').update(value).digest('hex');
    const requestKey = 'reject_' + hash(actor.openid + '\0' + input.requestId);
    const fingerprint = hash(JSON.stringify({ orderId: input.orderId, reason, expectedVersion: input.expectedVersion }));
    return this.repository.transaction(async tx => {
      const previous = await tx.get('request_keys', requestKey);
      if (previous) {
        ensure(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一requestId不能更改拒单参数');
        const refund = await tx.get('refunds', previous.refundId);
        ensure(refund && refund.source === 'MERCHANT_REJECTION' && refund.status === 'SUCCEEDED'
          && refund.orderId === input.orderId && refund.operatorOpenid === actor.openid,
        'INVALID_REFUND', '拒单退款记录不一致');
        return refund;
      }
      const order = await tx.get('orders', input.orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      const link = await tx.get('after_sale_links', order._id);
      const activeAfterSale = link ? await tx.get('after_sales', link.afterSaleId) : null;
      ensure(!['REQUESTED', 'APPROVED'].includes(activeAfterSale?.status),
        'AFTER_SALE_PENDING', '订单已有处理中售后，请通过售后流程处理');
      ensure(!await tx.get('refunds', 'refund_' + order._id), 'ALREADY_REFUNDED', '订单已经完成整单退款');
      ensure(order.version === input.expectedVersion, 'VERSION_CONFLICT', '订单已更新，请刷新后确认');
      ensure(order.status === STATUS.PENDING_ACCEPTANCE && order.paymentStatus === 'PAID',
        'INVALID_STATE', '仅允许拒绝已支付的待接单订单');
      const refund = await this.#executeRefund(tx, actor, order, { source: 'MERCHANT_REJECTION',
        requestId: input.requestId, reason, action: 'merchantReject', cancelReason: 'MERCHANT_REJECTION' });
      await tx.set('request_keys', requestKey, { fingerprint, orderId: order._id, refundId: refund._id });
      return refund;
    });
  }

  // 两个公开业务方法共用同一事务内的收款校验、退款、库存和日志写入。
  async #executeRefund(tx, actor, order, { source, afterSaleId, requestId, reason, action, cancelReason }) {
    ensure(order.paymentStatus === 'PAID' && [STATUS.PENDING_ACCEPTANCE, STATUS.ACCEPTED,
      STATUS.READY_FOR_PICKUP, STATUS.SHIPPING, STATUS.COMPLETED].includes(order.status),
    'INVALID_STATE', '只能退款已支付且允许售后的订单');
    const paymentId = 'pay_' + order._id;
    const payment = await tx.get('payments', paymentId);
    const amountCents = requireMoney(order.amounts.totalCents, '退款总额', 1);
    ensure(payment && payment.orderId === order._id && payment.status === 'SUCCEEDED'
      && payment.mode === 'SIMULATED' && payment.amountCents === amountCents,
    'INVALID_PAYMENT', '原支付记录与订单不一致');

    // 单店烘焙规则v1：尚未接单才自动恢复库存；接单后视为已开始备货，不自动恢复。
    const restock = order.status === STATUS.PENDING_ACCEPTANCE;
    const products = new Map();
    if (restock) {
      for (const item of order.items) {
        const product = await tx.get('products', item.productId);
        validateInventory(product);
        ensure(product && Number.isSafeInteger(product.onHand) && Number.isSafeInteger(product.reserved)
          && product.reserved >= 0 && product.onHand >= product.reserved
          && Number.isSafeInteger(product.onHand + item.quantity), 'INVALID_INVENTORY', '库存记录不合法，无法恢复');
        products.set(item.productId, product);
      }
    }
    const now = this.clock();
    const previousStatus = order.status;
    if (restock) {
      for (const item of order.items) {
        const product = products.get(item.productId);
        product.onHand += item.quantity;
        bumpInventoryVersion(product);
        await tx.set('products', item.productId, product);
        await writeInventoryMovement(tx, order, item, 'refundRestock', item.quantity, 0, now);
      }
    }
    if ([STATUS.PENDING_ACCEPTANCE, STATUS.ACCEPTED, STATUS.READY_FOR_PICKUP].includes(order.status)) {
      order.status = STATUS.CANCELLED;
      order.cancelReason = cancelReason;
      if (source === 'MERCHANT_REJECTION') order.rejectionReason = reason;
    }
    order.paymentStatus = 'REFUNDED';
    order.refundedAt = now;
    order.version += 1;
    order.updatedAt = now;
    const refundId = 'refund_' + order._id;
    const refund = { _id: refundId, orderId: order._id, paymentId, source, reason,
      ...(afterSaleId ? { afterSaleId } : {}), ...(requestId ? { requestId } : {}),
      amountCents, status: 'SUCCEEDED', mode: 'SIMULATED', restocked: restock,
      stockPolicyVersion: 'before-acceptance-only-v1', operatorOpenid: actor.openid, createdAt: now };
    await tx.set('refunds', refundId, refund);
    await tx.set('orders', order._id, order);
    await writeOrderEvent(tx, order, actor, action, previousStatus, now,
      { source, ...(afterSaleId ? { afterSaleId } : {}), reason, amountCents, restocked: restock });
    return refund;
  }
}

module.exports = { RefundService };
