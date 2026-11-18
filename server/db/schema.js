'use strict';

// 每个集合一张具名表：id 为主键，doc 保存完整领域对象 JSON，updated_at 记录写入时间。
// 具名表让数据库结构在报告和排查时可读；具体字段仍由领域层校验，schema 不重复声明业务约束。
const COLLECTIONS = Object.freeze([
  'addresses',
  'after_sale_events',
  'after_sale_links',
  'after_sales',
  'auth_events',
  'carts',
  'catalog_events',
  'inventory_movements',
  'notification_deliveries',
  'notification_outbox',
  'order_events',
  'orders',
  'payment_attempts',
  'payments',
  'pickup_codes',
  'products',
  'refunds',
  'request_keys',
  'shop_config',
  'shop_events',
  'staff_credentials',
  'staff_sessions',
  'stock_adjustments',
  'system_settings',
  'users'
]);

// 网页端新增：顾客账号凭据与 HTTP 会话。与员工凭据分开，避免把顾客提升为员工。
const WEB_COLLECTIONS = Object.freeze(['customer_credentials', 'web_sessions']);

const ALL_COLLECTIONS = Object.freeze([...COLLECTIONS, ...WEB_COLLECTIONS]);

const expr = field => `json_extract(doc,'$.${field}')`;

// 只覆盖真实查询路径：分页排序键与筛选键。索引全部是表达式索引，随 doc 自动维护。
const INDEXES = Object.freeze([
  ['addresses', [expr('ownerOpenid')], [expr('createdAt'), 'id']],
  ['after_sales', [expr('ownerOpenid')], [expr('createdAt'), 'id']],
  ['after_sales', [expr('status')], [expr('createdAt'), 'id']],
  ['carts', [expr('ownerOpenid')], [expr('updatedAt'), 'id']],
  ['notification_outbox', [expr('status')], [expr('nextAttemptAt'), 'id']],
  ['order_events', [expr('orderId')], [expr('createdAt'), 'id']],
  ['orders', [expr('ownerOpenid')], [expr('createdAt'), 'id']],
  ['orders', [expr('status')], [expr('createdAt'), 'id']],
  ['orders', [expr('status')], [expr('expiresAt'), 'id']],
  ['payments', [expr('ownerOpenid')], [expr('paidAt'), 'id']],
  ['products', [expr('category')], [expr('createdAt'), 'id']],
  ['refunds', [expr('ownerOpenid')], [expr('refundedAt'), 'id']],
  ['staff_sessions', [expr('openid')], [expr('expiresAt'), 'id']],
  ['users', [expr('username')], null, true],
  ['web_sessions', [expr('openid')], [expr('expiresAt'), 'id']],
  ['web_sessions', [expr('expiresAt')], null]
]);

const tableSql = name => `CREATE TABLE IF NOT EXISTS "${name}" (
  id TEXT PRIMARY KEY NOT NULL,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT`;

const indexSql = ([table, columns, order, unique = false]) => {
  const slug = (columns.join('_') + (order ? '_' + order.join('_') : ''))
    .replace(/json_extract\(doc,'\$\.([A-Za-z0-9_]+)'\)/g, '$1')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "ix_${table}_${slug}" ON "${table}" `
    + `(${columns.join(', ')}${order ? ', ' + order.join(', ') : ''})`;
};

const SCHEMA_VERSION = 1;

// 建表与建索引必须幂等：每次启动都会执行。
function applySchema(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  for (const name of ALL_COLLECTIONS) db.exec(tableSql(name));
  for (const index of INDEXES) db.exec(indexSql(index));
  // 版本号写在 SQLite 自带的 user_version 里，不占用业务集合 system_settings。
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (current > SCHEMA_VERSION) throw new Error('DATABASE_SCHEMA_TOO_NEW');
  if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { schemaVersion: SCHEMA_VERSION, collections: ALL_COLLECTIONS.length, indexes: INDEXES.length };
}

module.exports = { COLLECTIONS, WEB_COLLECTIONS, ALL_COLLECTIONS, INDEXES, SCHEMA_VERSION, applySchema };