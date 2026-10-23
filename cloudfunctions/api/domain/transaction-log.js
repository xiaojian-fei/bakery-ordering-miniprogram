'use strict';

async function writeOrderEvent(tx, order, actor, action, previousStatus, now, details = {}) {
  await tx.set('order_events', order._id + '_v' + order.version, { orderId: order._id,
    action, previousStatus, status: order.status, version: order.version,
    operator: { openid: actor.openid, role: actor.role }, createdAt: now, ...details });
}

async function writeInventoryMovement(tx, order, item, action, onHandDelta, reservedDelta, now) {
  await tx.set('inventory_movements', order._id + '_' + item.productId + '_' + action, {
    orderId: order._id, productId: item.productId, action, onHandDelta, reservedDelta, createdAt: now
  });
}

module.exports = { writeOrderEvent, writeInventoryMovement };
