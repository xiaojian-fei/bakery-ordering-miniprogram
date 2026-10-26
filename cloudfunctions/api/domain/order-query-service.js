'use strict';
const { ensure } = require('./errors');
const { requireCustomer, requireOwner, requireRole } = require('./auth');
const { STATUS } = require('./order-state');
const { id, page } = require('./service-utils');

class OrderQueryService {
  constructor(repository) { this.repository = repository; }
  async list(actor, input = {}) {
    requireCustomer(actor);
    if (input.manage === true) requireRole(actor, ['staff', 'owner']);
    const filters = input.manage === true ? [] : [{ field: 'ownerOpenid', value: actor.openid }];
    if (input.status !== undefined) {
      ensure(Object.values(STATUS).includes(input.status), 'INVALID_REQUEST', '订单状态不合法');
      filters.push({ field: 'status', value: input.status });
    }
    return this.repository.transaction(tx => page(tx, 'orders', { filters,
      scope: input.manage === true ? actor.openid + ':staff' : actor.openid, cursor: input.cursor, limit: input.limit }));
  }

  async timeline(actor, input) {
    requireCustomer(actor); id(input.orderId);
    if (input.manage === true) requireRole(actor, ['staff', 'owner']);
    return this.repository.transaction(async tx => {
      const order = await tx.get('orders', input.orderId);
      ensure(order, 'ORDER_NOT_FOUND', '订单不存在');
      if (input.manage !== true) requireOwner(actor, order);
      return page(tx, 'order_events', { filters: [{ field: 'orderId', value: order._id }],
        scope: (input.manage === true ? actor.openid + ':staff:' : actor.openid + ':') + order._id,
        cursor: input.cursor, limit: input.limit, desc: false, sortBy: 'version' });
    });
  }
}

module.exports = { OrderQueryService };
