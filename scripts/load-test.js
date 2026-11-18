'use strict';
/**
 * 并发与库存完整性验收。
 *
 *   node scripts/load-test.js
 *   LOAD_USERS=50 LOAD_STOCK=10 LOAD_QUERIES=300 node scripts/load-test.js
 *
 * 两个场景：
 *   1. 库存竞争：K 件库存，N 个顾客同时下单，必须恰好成功 K 单，其余全部 OUT_OF_STOCK，
 *      且最终 reserved 等于 K、可售为 0 —— 证明并发下不会超卖。
 *   2. 并发查询：Q 个请求同时打商品与订单列表，统计成功率与 p50/p95 延迟。
 *
 * 通过真实 HTTP 与真实 SQLite 执行，不使用任何内部后门。
 */
const { ApiClient } = require('./lib/api-client');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const USERS = Number(process.env.LOAD_USERS || 30);
const STOCK = Number(process.env.LOAD_STOCK || 10);
const QUERIES = Number(process.env.LOAD_QUERIES || 200);
const PASSWORD = 'load-pass-123456';

let failures = 0;
function check(label, ok, detail) {
  if (ok) { console.log('  ✔ ' + label); return; }
  failures += 1;
  console.error('  ✖ ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
}

const round = value => Math.round(value * 100) / 100;
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

async function registerUsers(count) {
  const users = [];
  const batchSize = 8;
  for (let start = 0; start < count; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) => {
      const index = start + offset;
      const client = new ApiClient(BASE);
      const username = 'load' + Date.now().toString(36).slice(-6) + index;
      return client.register(username, PASSWORD).then(() => ({ client, username }));
    });
    users.push(...await Promise.all(batch));
  }
  return users;
}

async function main() {
  console.log(`并发验收：${BASE}　用户 ${USERS}　库存 ${STOCK}　查询 ${QUERIES}`);
  const health = await new ApiClient(BASE).call('GET', '/healthz');
  if (health.status !== 200) throw new Error('服务未就绪');

  const owner = new ApiClient(BASE);
  await owner.login(OWNER_USERNAME, OWNER_PASSWORD);

  // 准备一个库存受控的商品
  const productId = 'load-' + Date.now().toString(36);
  await owner.action('catalog.save', {
    productId, requestId: 'load-product-' + Date.now().toString(36), expectedVersion: 0,
    name: '并发验收商品', priceCents: 100, desc: '仅用于并发验收', category: '测试',
    image: '', isOnSale: true, isFeatured: false
  });
  await owner.action('inventory.adjust', {
    requestId: 'load-stock-' + Date.now().toString(36), productId,
    onHand: STOCK, expectedVersion: 0, reason: '并发验收初始化库存'
  });

  // ---------- 场景 1：库存竞争 ----------
  console.log(`\n[场景 1] ${USERS} 个顾客同时抢 ${STOCK} 件库存`);
  const users = await registerUsers(USERS);
  check('注册并发顾客账号', users.length === USERS, users.length);

  const startedAt = Date.now();
  const results = await Promise.all(users.map(({ client }, index) => client.attempt('orders.create', {
    requestId: 'load-order-' + index + '-' + Date.now().toString(36),
    items: [{ productId, quantity: 1 }],
    deliveryType: 'pickup'
  })));
  const elapsed = Date.now() - startedAt;

  const succeeded = results.filter(result => result.ok).length;
  const outOfStock = results.filter(result => !result.ok && result.code === 'OUT_OF_STOCK').length;
  const otherErrors = results.filter(result => !result.ok && result.code !== 'OUT_OF_STOCK');

  check(`恰好成功 ${STOCK} 单（实际 ${succeeded}）`, succeeded === STOCK, { succeeded, expected: STOCK });
  check(`其余全部 OUT_OF_STOCK（${outOfStock} 单）`, outOfStock === USERS - STOCK, { outOfStock });
  check('没有其他类型的失败', otherErrors.length === 0, otherErrors.slice(0, 3).map(error => error.code));

  const product = await owner.action('catalog.get', { productId, includeUnavailable: true });
  check('库存被完全预留且不超卖', product.reserved === STOCK, { reserved: product.reserved });
  check('可售数量归零', product.available === 0, { available: product.available });

  // 订单与请求记录必须一一对应，不能出现"成功但没落库"或重复单
  const managed = await owner.action('orders.list', { manage: true, limit: 50 });
  const loadOrders = managed.items.filter(order => order.items.some(item => item.productId === productId));
  check('落库订单数等于成功数', loadOrders.length === STOCK, { stored: loadOrders.length });
  check('每个顾客最多一单', new Set(loadOrders.map(order => order.ownerOpenid)).size === loadOrders.length,
    loadOrders.length);

  console.log(`  并发下单 ${USERS} 请求耗时 ${elapsed} ms（${round(USERS / (elapsed / 1000))} 请求/秒）`);

  // ---------- 场景 2：并发查询 ----------
  console.log(`\n[场景 2] ${QUERIES} 个并发查询`);
  const latencies = [];
  let queryFailures = 0;
  const queryStart = Date.now();
  const batchSize = 25;
  for (let start = 0; start < QUERIES; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, QUERIES - start) }, (_, offset) => {
      const user = users[(start + offset) % users.length];
      const begin = process.hrtime.bigint();
      const action = (start + offset) % 2 === 0 ? 'catalog.list' : 'orders.list';
      return user.client.attempt(action, { limit: 20 }).then(result => {
        latencies.push(Number(process.hrtime.bigint() - begin) / 1e6);
        if (!result.ok) queryFailures += 1;
      });
    });
    await Promise.all(batch);
  }
  const queryElapsed = Date.now() - queryStart;

  check('并发查询全部成功', queryFailures === 0, { queryFailures });
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const max = Math.max(...latencies);
  console.log(`  查询 ${QUERIES} 次耗时 ${queryElapsed} ms（${round(QUERIES / (queryElapsed / 1000))} 请求/秒）`);
  console.log(`  单请求延迟 p50 ${round(p50)} ms　p95 ${round(p95)} ms　max ${round(max)} ms`);
  check('p95 延迟在 500ms 以内', p95 < 500, { p95 });

  const status = await owner.call('GET', '/healthz');
  check('服务在压测后仍然健康', status.status === 200 && status.body.ok === true, status.body);

  console.log(failures === 0 ? '\n并发与库存完整性验收通过' : `\n有 ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error('并发验收失败：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});