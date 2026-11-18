'use strict';
const { ensure } = require('./errors');
const { requireCustomer, requireOwner, requireRole } = require('./auth');
const { STATUS } = require('./order-state');
const { id, text, version, digest, once, page } = require('./service-utils');
const { writeAfterSaleEvent } = require('./transaction-log');

const eligible = [STATUS.PENDING_ACCEPTANCE, STATUS.ACCEPTED, STATUS.READY_FOR_PICKUP, STATUS.SHIPPING, STATUS.COMPLETED];
class AfterSaleService {
  constructor(repository, { clock = Date.now } = {}) { this.repository = repository; this.clock = clock; }

  async apply(actor, input) {
    requireCustomer(actor);
    const normalized = { orderId: id(input.orderId), reason: text(input.reason, '售后原因') };
    return this.repository.transaction(tx => once(tx, actor, 'after_apply', input.requestId, normalized, async () => {
      const order = await tx.get('orders', normalized.orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在'); requireOwner(actor, order);
      ensure(order.paymentStatus === 'PAID' && eligible.includes(order.status), 'INVALID_STATE', '订单不满足售后条件');
      const link = await tx.get('after_sale_links', order._id);
      const previous = link ? await tx.get('after_sales', link.afterSaleId) : null;
      ensure(!previous || previous.status === 'REJECTED', 'AFTER_SALE_EXISTS', '订单已有处理中或已完成售后');
      const afterSaleId = 'as_' + digest(actor.openid + '\0' + input.requestId).slice(0, 40);
      const now = this.clock();
      const record = { _id: afterSaleId, orderId: order._id, ownerOpenid: actor.openid,
        reason: normalized.reason, status: 'REQUESTED', version: 1, createdAt: now, orderVersionAtApply: order.version };
      await tx.set('after_sales', afterSaleId, record);
      await tx.set('after_sale_links', order._id, { afterSaleId });
      await writeAfterSaleEvent(tx, record, actor, 'APPLY', now);
      return record;
    }));
  }

  async review(actor, input) {
    requireRole(actor, ['owner']);
    const normalized = { afterSaleId: id(input.afterSaleId), expectedVersion: version(input.expectedVersion, 1),
      decision: input.decision, reason: text(input.reason, '审核说明') };
    ensure(['approve', 'reject'].includes(normalized.decision), 'INVALID_REQUEST', '审核决定不合法');
    return this.repository.transaction(tx => once(tx, actor, 'after_review', input.requestId, normalized, async () => {
      const record = await tx.get('after_sales', normalized.afterSaleId);
      ensure(record, 'AFTER_SALE_NOT_FOUND', '售后不存在');
      const order = await tx.get('orders', record.orderId);
      ensure(order && order.ownerOpenid === record.ownerOpenid, 'INVALID_AFTER_SALE', '售后归属不一致');
      ensure(record.status === 'REQUESTED', 'INVALID_STATE', '售后已经审核');
      ensure(record.version === normalized.expectedVersion, 'VERSION_CONFLICT', '售后已更新');
      ensure(order.paymentStatus === 'PAID' && eligible.includes(order.status), 'INVALID_STATE', '订单已退款或不允许继续审核');
      const now = this.clock();
      record.status = normalized.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      record.version += 1; record.reviewedBy = actor.openid; record.reviewedAt = now; record.reviewReason = normalized.reason;
      if (record.status === 'APPROVED') { record.approvedBy = actor.openid; record.approvedAt = now; }
      await tx.set('after_sales', record._id, record);
      await writeAfterSaleEvent(tx, record, actor, record.status, now, { reason: normalized.reason });
      return record;
    }));
  }

  async get(actor, afterSaleId, { manage = false } = {}) {
    requireCustomer(actor); id(afterSaleId);
    if (manage) requireRole(actor, ['owner']);
    return this.repository.transaction(async tx => {
      const record = await tx.get('after_sales', afterSaleId);
      ensure(record, 'AFTER_SALE_NOT_FOUND', '售后不存在');
      if (!manage) requireOwner(actor, record);
      return record;
    });
  }

  async list(actor, input = {}) {
    requireCustomer(actor);
    if (input.manage === true) requireRole(actor, ['owner']);
    const filters = input.manage === true ? [] : [{ field: 'ownerOpenid', value: actor.openid }];
    if (input.status !== undefined) {
      ensure(['REQUESTED', 'APPROVED', 'REJECTED', 'REFUNDED'].includes(input.status), 'INVALID_REQUEST', '售后状态不合法');
      filters.push({ field: 'status', value: input.status });
    }
    return this.repository.transaction(tx => page(tx, 'after_sales', { filters,
      scope: input.manage === true ? actor.openid + ':owner' : actor.openid,
      cursor: input.cursor, limit: input.limit }));
  }
}

module.exports = { AfterSaleService };
