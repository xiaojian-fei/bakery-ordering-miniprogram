'use strict';
const { requireCustomer, requireRole } = require('./auth');
const { page } = require('./service-utils');

class NotificationService {
  constructor(repository) { this.repository = repository; }
  async list(actor, input = {}) {
    requireCustomer(actor);
    if (input.manage === true) requireRole(actor, ['owner']);
    return this.repository.transaction(async tx => {
      const result = await page(tx, 'notification_outbox', {
        filters: input.manage === true ? [] : [{ field: 'ownerOpenid', value: actor.openid }],
        scope: input.manage === true ? actor.openid + ':owner' : actor.openid,
        limit: input.limit, cursor: input.cursor });
      return { ...result, items: result.items.map(row => ({ eventId: row._id, orderId: row.orderId,
        eventType: row.eventType, createdAt: row.createdAt, status: row.status, attempts: row.attempts })) };
    });
  }
}
module.exports = { NotificationService };
