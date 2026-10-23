'use strict';

// 仅测试用途：串行执行 + 隔离副本提交，用于检查业务不变量与失败回滚。
// 这里的串行化不是云数据库事务实现，不能据此宣称云端不会超卖。
class MemoryRepository {
  constructor(seed = {}) {
    this.state = structuredClone(seed);
    this.queue = Promise.resolve();
    this.failNextCommit = false;
  }

  transaction(work) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const tx = {
        async get(table, id) {
          return Object.hasOwn(draft, table) && Object.hasOwn(draft[table], id)
            ? structuredClone(draft[table][id]) : null;
        },
        async set(table, id, record) {
          if (!draft[table]) draft[table] = {};
          Object.defineProperty(draft[table], id, { value: structuredClone(record), enumerable: true,
            configurable: true, writable: true });
        }
      };
      const result = await work(tx);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('INJECTED_COMMIT_FAILURE');
      }
      this.state = draft;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  snapshot() { return structuredClone(this.state); }

  async findExpiredOrders({ dueAt, after, limit }) {
    await this.queue;
    return Object.values(this.state.orders || {})
      .filter(order => order.status === 'PENDING_PAYMENT' && order.expiresAt <= dueAt
        && (!after || order.expiresAt > after.expiresAt
          || (order.expiresAt === after.expiresAt && order._id > after.orderId)))
      .sort((a, b) => a.expiresAt - b.expiresAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
      .slice(0, limit).map(order => ({ orderId: order._id, expiresAt: order.expiresAt }));
  }
}

module.exports = { MemoryRepository };
