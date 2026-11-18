'use strict';
const { DatabaseSync } = require('node:sqlite');
const { ALL_COLLECTIONS, applySchema } = require('./schema');

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const OPERATORS = new Set(['eq', 'ne', 'gte', 'lt', 'lte', 'in', 'contains']);

// 领域层只使用下面这组操作符；参数一律走占位符，字段名走白名单正则，不拼接客户端字符串。
function fieldExpr(field) {
  if (field === '_id') return 'id';
  if (!FIELD.test(field)) throw new Error('INVALID_QUERY_FIELD');
  return `json_extract(doc,'$.${field}')`;
}

// SQLite 的 JSON 真值读出为 1/0，Node 绑定布尔也映射为 1/0，两边保持一致。
function bindable(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === undefined || value === null) return null;
  return value;
}

const toRow = record => ({ ...JSON.parse(record.doc), _id: record.id });
const parseJson = text => JSON.parse(text);

/**
 * SQLite 持久化仓储适配器。
 *
 * 与内存测试夹具保持相同的外部契约：transaction / tx.get / tx.set / tx.query /
 * findExpiredOrders / snapshot / failNextCommit。领域层代码不需要任何改动。
 *
 * 事务通过串行队列排队，避免“事务内再开事务”；这也是内存版的既有语义。
 */
class SqliteRepository {
  constructor(seed = {}, { file = ':memory:', clock = Date.now } = {}) {
    this.file = file;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.failNextCommit = false;
    this.closed = false;
    this.statements = new Map();
    this.db = new DatabaseSync(file);
    this.info = applySchema(this.db);
    if (seed && typeof seed === 'object') this.seed(seed);
  }

  /** 把 {集合: {id: 对象}} 形态的种子数据写入空库；已存在的 id 不覆盖。 */
  seed(seed) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, rows] of Object.entries(seed)) {
        if (!ALL_COLLECTIONS.includes(table)) throw new Error('UNKNOWN_COLLECTION:' + table);
        for (const [id, doc] of Object.entries(rows)) this.setRow(table, id, doc);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* 回滚失败不覆盖原始错误 */ }
      throw error;
    }
    return this;
  }

  prepare(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }

  setRow(table, id, doc) {
    this.prepare(`INSERT INTO "${table}" (id, doc, updated_at) VALUES (?, ?, ?) `
      + 'ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at')
      .run(id, JSON.stringify(doc), this.clock());
  }

  /** 事务串行化：与内存夹具一致，工作体返回前不提交，异常则整体回滚。 */
  transaction(work) {
    const run = async () => {
      if (this.closed) throw new Error('REPOSITORY_CLOSED');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(this.transactionApi());
        if (this.failNextCommit) {
          this.failNextCommit = false;
          throw new Error('INJECTED_COMMIT_FAILURE');
        }
        this.db.exec('COMMIT');
        return result === undefined ? undefined : parseJson(JSON.stringify(result));
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch (_) { /* 已回滚或语句失败 */ }
        throw error;
      }
    };
    const operation = this.queue.then(run);
    this.queue = operation.catch(() => {});
    return operation;
  }

  transactionApi() {
    const repository = this;
    return {
      async get(table, id) {
        repository.assertTable(table);
        const row = repository.prepare(`SELECT doc FROM "${table}" WHERE id = ?`).get(id);
        return row ? parseJson(row.doc) : null;
      },
      async set(table, id, record) {
        repository.assertTable(table);
        if (typeof id !== 'string' || id.length === 0) throw new Error('INVALID_ID');
        repository.setRow(table, id, record);
      },
      async query(table, { filters = [], orderBy = [{ field: '_id', direction: 'asc' }], after = null, limit = 20 } = {}) {
        repository.assertTable(table);
        return repository.runQuery(table, { filters, orderBy, after, limit });
      }
    };
  }

  assertTable(table) {
    if (!ALL_COLLECTIONS.includes(table)) throw new Error('UNKNOWN_COLLECTION:' + table);
  }

  runQuery(table, { filters, orderBy, after, limit }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_QUERY_LIMIT');
    const params = [];
    const where = [];
    for (const { field, op = 'eq', value } of filters) {
      if (!OPERATORS.has(op)) throw new Error('INVALID_QUERY_OPERATOR');
      const target = fieldExpr(field);
      if (op === 'eq') {
        where.push(`${target} = ?`);
        params.push(bindable(value));
      } else if (op === 'ne') {
        // 与内存版一致：字段缺失或为 null 的行也算“不等于给定值”。
        where.push(`(${target} IS NULL OR ${target} <> ?)`);
        params.push(bindable(value));
      } else if (op === 'gte') {
        where.push(`${target} >= ?`);
        params.push(bindable(value));
      } else if (op === 'lt') {
        where.push(`${target} < ?`);
        params.push(bindable(value));
      } else if (op === 'lte') {
        where.push(`${target} <= ?`);
        params.push(bindable(value));
      } else if (op === 'in') {
        if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('INVALID_QUERY_OPERATOR');
        where.push(`${target} IN (${value.map(() => '?').join(', ')})`);
        for (const item of value) params.push(bindable(item));
      } else {
        // contains 使用 instr 而非 LIKE，避免 % 和 _ 被当成通配符。
        where.push(`instr(lower(${target}), lower(?)) > 0`);
        params.push(String(value));
      }
    }
    if (after) where.push(this.cursorClause(orderBy, after, params));
    const directions = orderBy.map(({ field, direction }) => `${fieldExpr(field)} ${direction === 'desc' ? 'DESC' : 'ASC'}`);
    if (!orderBy.some(({ field }) => field === '_id')) directions.push('id ASC');
    const sql = `SELECT id, doc FROM "${table}"`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ` ORDER BY ${directions.join(', ')} LIMIT ?`;
    params.push(limit);
    return this.prepare(sql).all(...params).map(toRow);
  }

  /** 复合游标：等价于内存版 compare(row, after) > 0，逐字段按方向严格大于。 */
  cursorClause(orderBy, after, params) {
    const branches = orderBy.map(({ field, direction }, index) => {
      const parts = [];
      for (let i = 0; i < index; i += 1) {
        parts.push(`${fieldExpr(orderBy[i].field)} = ?`);
        params.push(bindable(after[orderBy[i].field]));
      }
      parts.push(`${fieldExpr(field)} ${direction === 'desc' ? '<' : '>'} ?`);
      params.push(bindable(after[field]));
      return '(' + parts.join(' AND ') + ')';
    });
    return '(' + branches.join(' OR ') + ')';
  }

  /** 只读快照，形态与内存夹具一致：{集合: {id: 文档}}，空集合不出现。 */
  snapshot() {
    const state = {};
    for (const table of ALL_COLLECTIONS) {
      const rows = this.prepare(`SELECT id, doc FROM "${table}"`).all();
      if (rows.length === 0) continue;
      state[table] = {};
      for (const row of rows) state[table][row.id] = parseJson(row.doc);
    }
    return state;
  }

  /** 供超时任务使用：按到期时间与订单 ID 递增的分页游标查询。 */
  async findExpiredOrders({ dueAt, after, limit }) {
    await this.queue;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_QUERY_LIMIT');
    const params = [dueAt];
    let sql = 'SELECT id, doc FROM "orders" WHERE json_extract(doc,\'$.status\') = \'PENDING_PAYMENT\' '
      + "AND json_extract(doc,'$.expiresAt') <= ?";
    if (after) {
      sql += " AND (json_extract(doc,'$.expiresAt') > ? OR (json_extract(doc,'$.expiresAt') = ? AND id > ?))";
      params.push(after.expiresAt, after.expiresAt, after.orderId);
    }
    sql += " ORDER BY json_extract(doc,'$.expiresAt') ASC, id ASC LIMIT ?";
    params.push(limit);
    return this.prepare(sql).all(...params).map(row => {
      const doc = parseJson(row.doc);
      return { orderId: row.id, expiresAt: doc.expiresAt };
    });
  }

  /** 备份：sqlite 在线备份到指定文件。 */
  async backup(targetFile) {
    await this.queue;
    this.db.exec(`VACUUM INTO '${String(targetFile).replace(/'/g, "''")}'`);
    return targetFile;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}

module.exports = { SqliteRepository };