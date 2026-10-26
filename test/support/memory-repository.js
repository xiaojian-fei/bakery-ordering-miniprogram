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
        },
        async query(table, { filters = [], orderBy = [{ field: '_id', direction: 'asc' }], after = null, limit = 20 } = {}) {
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_QUERY_LIMIT');
          const compare = (left, right) => {
            for (const { field, direction } of orderBy) {
              if (left[field] === right[field]) continue;
              return (left[field] < right[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
            }
            return 0;
          };
          const match = (row, { field, op = 'eq', value }) => {
            if (op === 'eq') return row[field] === value;
            if (op === 'ne') return row[field] !== value;
            if (op === 'gte') return row[field] >= value;
            if (op === 'lt') return row[field] < value;
            if (op === 'lte') return row[field] <= value;
            if (op === 'in') return Array.isArray(value) && value.includes(row[field]);
            if (op === 'contains') return typeof row[field] === 'string' && row[field].toLowerCase().includes(value.toLowerCase());
            throw new Error('INVALID_QUERY_OPERATOR');
          };
          return Object.entries(Object.hasOwn(draft, table) ? draft[table] : {})
            .map(([key, row]) => ({ ...structuredClone(row), _id: key }))
            .filter(row => filters.every(filter => match(row, filter)) && (!after || compare(row, after) > 0))
            .sort(compare).slice(0, limit);
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
