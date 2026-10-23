'use strict';
const { ensure } = require('./errors');
const { requireOwner, requireRole } = require('./auth');

const STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT', PENDING_ACCEPTANCE: 'PENDING_ACCEPTANCE',
  ACCEPTED: 'ACCEPTED', SHIPPING: 'SHIPPING', READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED'
});

function nextStatus(order, action, actor, now) {
  const pending = order.status === STATUS.PENDING_PAYMENT;
  if (action === 'pay' || action === 'cancel') {
    requireOwner(actor, order);
    ensure(pending, 'INVALID_STATE', '当前订单不能执行此操作');
    ensure(now < order.expiresAt, 'ORDER_EXPIRED', '订单支付时间已截止');
    return action === 'pay' ? STATUS.PENDING_ACCEPTANCE : STATUS.CANCELLED;
  }
  if (action === 'expire') {
    requireRole(actor, ['system']);
    ensure(pending && now >= order.expiresAt, 'INVALID_STATE', '订单尚未到期或已经处理');
    return STATUS.EXPIRED;
  }
  requireRole(actor, ['staff', 'owner']);
  if (action === 'accept') {
    ensure(order.status === STATUS.PENDING_ACCEPTANCE, 'INVALID_STATE', '只能接受待接单订单');
    return STATUS.ACCEPTED;
  }
  if (action === 'ship' || action === 'readyForPickup') {
    ensure(order.status === STATUS.ACCEPTED, 'INVALID_STATE', '订单尚未接单');
    const delivery = action === 'ship';
    ensure(order.deliveryType === (delivery ? 'delivery' : 'pickup'), 'INVALID_DELIVERY', '履约方式不匹配');
    return delivery ? STATUS.SHIPPING : STATUS.READY_FOR_PICKUP;
  }
  if (action === 'complete') {
    ensure([STATUS.SHIPPING, STATUS.READY_FOR_PICKUP].includes(order.status), 'INVALID_STATE', '订单尚未进入履约阶段');
    return STATUS.COMPLETED;
  }
  ensure(false, 'INVALID_ACTION', '未知订单动作');
}

module.exports = { STATUS, nextStatus };
