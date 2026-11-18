'use strict';
const { randomBytes } = require('node:crypto');
const { ensure } = require('../domain/errors');

// send为显式注入的通道，测试只注入假发送器。没有默认webhook或任何网络请求。
class NotificationJob {
  constructor({ repository, send, clock = Date.now, leaseMs = 30000, maxAttempts = 5 } = {}) {
    ensure(typeof repository?.transaction === 'function' && typeof send === 'function' && typeof clock === 'function'
      && Number.isSafeInteger(leaseMs) && leaseMs > 0 && Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10,
    'INVALID_CONFIG', '通知任务配置不合法');
    Object.assign(this, { repository, send, clock, leaseMs, maxAttempts });
  }
  async run({ limit = 20 } = {}) {
    ensure(Number.isInteger(limit) && limit >= 1 && limit <= 50, 'INVALID_REQUEST', '通知批大小需为1～50');
    const now = this.clock();
    const batch = await this.repository.transaction(async tx => {
      ensure(typeof tx.query === 'function', 'INVALID_CONFIG', '缺少查询适配器');
      const orderBy = [{ field: '_id', direction: 'asc' }];
      const pending = await tx.query('notification_outbox', { filters: [{ field: 'status', value: 'PENDING' },
        { field: 'nextAttemptAt', op: 'lte', value: now }], orderBy, limit });
      const stale = await tx.query('notification_outbox', { filters: [{ field: 'status', value: 'PROCESSING' },
        { field: 'leaseUntil', op: 'lte', value: now }], orderBy, limit });
      const rows = [...pending, ...stale].sort((a, b) => a.createdAt - b.createdAt || (a._id < b._id ? -1 : 1)).slice(0, limit);
      const acquired = [];
      let exhausted = 0;
      for (const row of rows) {
        if (row.attempts >= this.maxAttempts) {
          await tx.set('notification_outbox', row._id, { ...row, status: 'FAILED', leaseToken: null, leaseUntil: 0 });
          exhausted += 1;
          continue;
        }
        const record = { ...row, status: 'PROCESSING', attempts: row.attempts + 1,
          leaseToken: randomBytes(16).toString('hex'), leaseUntil: now + this.leaseMs };
        await tx.set('notification_outbox', row._id, record);
        acquired.push(record);
      }
      return { acquired, exhausted };
    });
    const result = { claimed: batch.acquired.length, delivered: 0, retrying: 0, failed: batch.exhausted, leaseLost: 0 };
    for (const row of batch.acquired) {
      let delivered = false;
      try { delivered = (await this.send({ eventId: row._id, orderId: row.orderId,
        ownerOpenid: row.ownerOpenid, eventType: row.eventType }))?.delivered === true; }
      catch (_) { /* 不保存原始通道异常，避免写入凭据/地址。 */ }
      const status = await this.repository.transaction(async tx => {
        const latest = await tx.get('notification_outbox', row._id);
        if (latest?.status !== 'PROCESSING' || latest.leaseToken !== row.leaseToken) return 'leaseLost';
        const time = this.clock();
        latest.status = delivered ? 'DELIVERED' : row.attempts >= this.maxAttempts ? 'FAILED' : 'PENDING';
        latest.nextAttemptAt = delivered ? 0 : time + Math.min(60000, 1000 * 2 ** (row.attempts - 1));
        latest.leaseToken = null; latest.leaseUntil = 0;
        if (delivered) latest.deliveredAt = time;
        await tx.set('notification_outbox', row._id, latest);
        await tx.set('notification_deliveries', row._id + '_attempt_' + row.attempts,
          { eventId: row._id, attempt: row.attempts, createdAt: time, status: delivered ? 'DELIVERED' : 'DELIVERY_FAILED' });
        return delivered ? 'delivered' : latest.status === 'FAILED' ? 'failed' : 'retrying';
      });
      result[status] += 1;
    }
    return result;
  }
}
module.exports = { NotificationJob };
