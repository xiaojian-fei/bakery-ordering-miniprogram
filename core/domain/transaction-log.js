'use strict';

async function writeOrderEvent(tx, order, actor, action, previousStatus, now, details = {}) {
  await tx.set('order_events', order._id + '_v' + order.version, { orderId: order._id,
    action, previousStatus, status: order.status, version: order.version,
    operator: { openid: actor.openid, role: actor.role }, createdAt: now, ...details });
  await recordNotification(tx, { eventId: 'order_' + order._id + '_v' + order.version,
    orderId: order._id, ownerOpenid: order.ownerOpenid, eventType: action, createdAt: now });
}

async function recordNotification(tx, { eventId, orderId, ownerOpenid, eventType, createdAt }) {
  await tx.set('notification_outbox', eventId, { _id: eventId, orderId, ownerOpenid, eventType, createdAt,
    status: 'PENDING', attempts: 0, nextAttemptAt: createdAt, leaseUntil: 0, leaseToken: null });
}

async function writeAfterSaleEvent(tx, record, actor, action, now, details = {}) {
  const eventId = record._id + '_v' + record.version;
  await tx.set('after_sale_events', eventId, { afterSaleId: record._id, orderId: record.orderId,
    ownerOpenid: record.ownerOpenid, action, operatorOpenid: actor.openid, createdAt: now, ...details });
  await recordNotification(tx, { eventId: 'after_' + eventId, orderId: record.orderId,
    ownerOpenid: record.ownerOpenid, eventType: 'afterSale.' + action, createdAt: now });
}

async function writeInventoryMovement(tx, order, item, action, onHandDelta, reservedDelta, now) {
  await tx.set('inventory_movements', order._id + '_' + item.productId + '_' + action, {
    orderId: order._id, productId: item.productId, action, onHandDelta, reservedDelta, createdAt: now
  });
}

module.exports = { writeOrderEvent, writeInventoryMovement, writeAfterSaleEvent };
