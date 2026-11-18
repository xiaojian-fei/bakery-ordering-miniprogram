'use strict';
const { BusinessError, ensure } = require('../domain/errors');
const { validId } = require('../domain/pricing');
const { STATUS } = require('../domain/order-state');

const afterCursor = (row, cursor) => !cursor || row.expiresAt > cursor.expiresAt
  || (row.expiresAt === cursor.expiresAt && row.orderId > cursor.orderId);

// 受信后台任务：只注入候选查询和原子expire操作，不处理客户端身份或开启定时器。
class OrderExpiryJob {
  constructor({ findCandidates, expireOrder, clock = Date.now } = {}) {
    ensure(typeof findCandidates === 'function' && typeof expireOrder === 'function'
      && typeof clock === 'function', 'INVALID_CONFIG', '超时任务需要候选查询、原子处理与时钟');
    this.findCandidates = findCandidates;
    this.expireOrder = expireOrder;
    this.clock = clock;
  }

  async run({ batchSize = 50, maxBatches = 10 } = {}) {
    ensure(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 100
      && Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 20,
    'INVALID_REQUEST', '批大小需为1～100，批次数需为1～20');
    const dueAt = this.clock();
    ensure(Number.isSafeInteger(dueAt) && dueAt >= 0, 'INVALID_CONFIG', '任务时间不合法');
    const result = { dueAt, scanned: 0, expired: 0, skipped: 0, failed: 0, failures: [], truncated: false };
    let cursor = null;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // 固定截止时刻、用二元游标分页，不能用会随订单消失而跳行的offset。
      const rows = await this.findCandidates({ dueAt, after: cursor ? { ...cursor } : null, limit: batchSize });
      ensure(Array.isArray(rows) && rows.length <= batchSize, 'INVALID_ADAPTER', '候选查询返回格式不合法');
      let previous = cursor;
      for (const row of rows) {
        ensure(row && validId(row.orderId) && Number.isSafeInteger(row.expiresAt)
          && row.expiresAt >= 0 && row.expiresAt <= dueAt && afterCursor(row, previous),
        'INVALID_ADAPTER', '候选必须按到期时间和订单ID递增且不可重复');
        previous = row;
      }
      for (const row of rows) {
        result.scanned += 1;
        try {
          // 这里重新读取事务中的最新状态，查询结果不是扣库存的依据。
          const order = await this.expireOrder(row.orderId);
          ensure(order && order._id === row.orderId && Object.values(STATUS).includes(order.status)
            && order.status !== STATUS.PENDING_PAYMENT,
            'INVALID_ADAPTER', '超时操作没有返回已处理订单');
          if (order.status === STATUS.EXPIRED) result.expired += 1;
          else result.skipped += 1;
        } catch (error) {
          result.failed += 1;
          result.failures.push({ orderId: row.orderId,
            code: error instanceof BusinessError ? error.code : 'INTERNAL_ERROR' });
        }
      }
      if (rows.length < batchSize) return result;
      const last = rows.at(-1);
      cursor = { expiresAt: last.expiresAt, orderId: last.orderId };
    }
    // 恰好满批时也保守标记为截断；下次触发从头扫描，重试失败项。
    result.truncated = true;
    return result;
  }
}

module.exports = { OrderExpiryJob };
