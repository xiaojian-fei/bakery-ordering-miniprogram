'use strict';
const { ensure } = require('./errors');
const { requireRole } = require('./auth');
const { requireMoney } = require('./pricing');
const { collect } = require('./service-utils');

class StatisticsService {
  constructor(repository) { this.repository = repository; }
  async summary(actor, { startAt, endAt }) {
    requireRole(actor, ['owner']);
    ensure(Number.isSafeInteger(startAt) && startAt >= 0 && Number.isSafeInteger(endAt) && endAt > startAt
      && endAt - startAt <= 31 * 86400000, 'INVALID_REQUEST', '统计需提供不超过31天的时间范围');
    return this.repository.transaction(async tx => {
      const time = field => [{ field, op: 'gte', value: startAt }, { field, op: 'lt', value: endAt }];
      const money = [{ field: 'status', value: 'SUCCEEDED' }, { field: 'mode', value: 'SIMULATED' }, ...time('createdAt')];
      const payments = await collect(tx, 'payments', money);
      const refunds = await collect(tx, 'refunds', money);
      const completed = await collect(tx, 'orders', [{ field: 'status', value: 'COMPLETED' },
        { field: 'paymentStatus', value: 'PAID' }, ...time('completedAt')]);
      const sum = rows => rows.reduce((total, row) => requireMoney(total + requireMoney(row.amountCents, '财务记录', 1), '财务合计'), 0);
      const grossCents = sum(payments), refundCents = sum(refunds);
      const netCents = grossCents - refundCents;
      ensure(Number.isSafeInteger(netCents), 'INVALID_AMOUNT', '净额超出范围');
      const sales = new Map();
      for (const order of completed) {
        for (const item of order.items) {
          ensure(Number.isSafeInteger(item.quantity) && item.quantity > 0, 'INVALID_ITEMS', '销量数据不合法');
          const previous = sales.get(item.productId) || { productId: item.productId, name: item.name, quantity: 0 };
          previous.quantity += item.quantity;
          ensure(Number.isSafeInteger(previous.quantity), 'INVALID_QUANTITY', '销量超出范围');
          sales.set(item.productId, previous);
        }
      }
      return { startAt, endAt, dataMode: 'SIMULATED', grossCents, refundCents, netCents,
        paidOrderCount: payments.length, refundedOrderCount: refunds.length, completedOrderCount: completed.length,
        productSales: [...sales.values()].sort((a, b) => a.productId < b.productId ? -1 : 1),
        salesBasis: 'CURRENT_PAID_COMPLETED_ORDERS_BY_COMPLETED_AT' };
    });
  }
}

module.exports = { StatisticsService };
