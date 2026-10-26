'use strict';
const { createHash } = require('node:crypto');
const { ensure } = require('./errors');
const { validId } = require('./pricing');

const digest = value => createHash('sha256').update(value).digest('hex');
function text(value, label, max = 200, empty = false) {
  ensure(typeof value === 'string' && value.length <= max && (empty || value.trim()),
    'INVALID_REQUEST', label + '不合法');
  return value.trim();
}
function version(value, minimum = 0) {
  ensure(Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER,
    'INVALID_REQUEST', '必须提供合法版本');
  return value;
}
function id(value) { ensure(validId(value), 'INVALID_REQUEST', 'ID不合法'); return value; }
async function once(tx, actor, namespace, requestId, normalized, work) {
  ensure(validId(requestId) && requestId.length >= 8, 'INVALID_REQUEST', 'requestId需为8～80位');
  const key = namespace + '_' + digest(actor.openid + '\0' + requestId);
  const fingerprint = digest(JSON.stringify(normalized));
  const previous = await tx.get('request_keys', key);
  if (previous) {
    ensure(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '重试参数与原请求不一致');
    return previous.result;
  }
  const result = await work();
  await tx.set('request_keys', key, { fingerprint, result });
  return result;
}

// 声明式查询由实际数据库适配器翻译；不能把客户提供的任意筛选直接传到数据库。
async function page(tx, table, { filters = [], scope, cursor, limit = 20, sortBy = 'createdAt', desc = true } = {}) {
  ensure(typeof tx.query === 'function', 'INVALID_CONFIG', '缺少有界查询适配器');
  ensure(Number.isInteger(limit) && limit >= 1 && limit <= 50, 'INVALID_REQUEST', '每页需为1～50条');
  const orderBy = sortBy === '_id' ? [{ field: '_id', direction: desc ? 'desc' : 'asc' }]
    : [{ field: sortBy, direction: desc ? 'desc' : 'asc' }, { field: '_id', direction: desc ? 'desc' : 'asc' }];
  const scopeHash = digest(JSON.stringify([table, scope, filters, orderBy]));
  let after = null;
  if (cursor !== undefined && cursor !== null) {
    ensure(typeof cursor === 'string' && cursor.length <= 2048, 'INVALID_CURSOR', '分页游标不合法');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch (_) {}
    ensure(decoded?.scope === scopeHash && decoded.after && validId(decoded.after._id), 'INVALID_CURSOR', '游标与查询不匹配');
    if (sortBy !== '_id') ensure(Number.isSafeInteger(decoded.after[sortBy]), 'INVALID_CURSOR', '游标排序值不合法');
    after = decoded.after;
  }
  const rows = await tx.query(table, { filters, orderBy, after, limit: limit + 1 });
  ensure(Array.isArray(rows) && rows.length <= limit + 1, 'INVALID_ADAPTER', '分页结果不合法');
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ scope: scopeHash,
    after: Object.fromEntries(orderBy.map(({ field }) => [field, last[field]])) })).toString('base64url') : null;
  return { items, nextCursor };
}

async function collect(tx, table, filters) {
  ensure(typeof tx.query === 'function', 'INVALID_CONFIG', '缺少有界查询适配器');
  const result = [];
  let after = null;
  while (true) {
    const rows = await tx.query(table, { filters, orderBy: [{ field: '_id', direction: 'asc' }], after, limit: 100 });
    ensure(Array.isArray(rows) && rows.length <= 100, 'INVALID_ADAPTER', '查询结果不合法');
    result.push(...rows);
    ensure(result.length <= 10000, 'REPORT_TOO_LARGE', '数据量过大，请缩小日期范围');
    if (rows.length < 100) return result;
    const last = rows.at(-1)._id;
    ensure(validId(last) && (!after || last > after._id), 'INVALID_ADAPTER', '查询游标未前进');
    after = { _id: last };
  }
}

module.exports = { digest, text, version, id, once, page, collect };
