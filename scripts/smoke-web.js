'use strict';
/**
 * 网页端端到端冒烟验证。
 *
 *   node scripts/smoke-web.js run      全流程：注册 → 下单 → 支付 → 履约 → 售后 → 退款 → 统计
 *   node scripts/smoke-web.js verify   重启服务后校验订单仍在、金额与状态未变
 *
 * 全程走真实 HTTP 与真实 SQLite，用的是浏览器同一份 shared/trade-client。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createTradeClient } = require('../shared/trade-client');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const STATE_FILE = path.resolve(__dirname, '..', 'data', 'smoke-state.json');
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const STAFF_USERNAME = process.env.SMOKE_STAFF_USERNAME || 'smoke.staff';
const STAFF_PASSWORD = process.env.SMOKE_STAFF_PASSWORD || 'staff-pass-123456';
const CUSTOMER_PASSWORD = 'customer-pass-1234';

let passed = 0;
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✔ ' + label);
    return;
  }
  console.error('  ✖ ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  process.exitCode = 1;
}

/** 极简 Cookie 罐：网页端靠浏览器自动处理，这里显式模拟。 */
class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  get(name) { return this.cookies.get(name); }
}

async function request(jar, method, pathname, body) {
  const response = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.cookies.size ? { Cookie: jar.header() } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  jar.absorb(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
  return { status: response.status, body: json, text };
}

async function login(jar, username, password) {
  const result = await request(jar, 'POST', '/api/login', { username, password });
  if (result.status !== 200) throw new Error('登录失败：' + JSON.stringify(result.body));
  const session = await request(jar, 'GET', '/api/session');
  return session.body;
}

function clientFor(jar, session) {
  return createTradeClient({
    // 员工令牌走 HttpOnly Cookie，与浏览器一致：只声明角色，不传令牌原文。
    staffSession: session.staffRole ? { role: session.staffRole, expiresAt: session.expiresAt } : null,
    send: async envelope => {
      const result = await request(jar, 'POST', '/api/action', envelope);
      return result.body;
    }
  });
}

const rid = prefix => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

async function run() {
  console.log(`端到端冒烟：${BASE}`);
  const health = await request(new Jar(), 'GET', '/healthz');
  check('健康检查可达', health.status === 200 && health.body.ok === true, health.body);

  // 未登录访问业务接口必须被拒绝
  const anonymous = await request(new Jar(), 'POST', '/api/action', { action: 'catalog.list', data: {} });
  check('未登录调用业务接口返回 401', anonymous.status === 401, anonymous.status);

  // 店主登录
  const ownerJar = new Jar();
  const ownerSession = await login(ownerJar, OWNER_USERNAME, OWNER_PASSWORD);
  check('店主登录并取得员工会话', ownerSession.staffRole === 'owner', ownerSession);
  const owner = clientFor(ownerJar, ownerSession);

  // 店主创建员工账号（幂等：已存在则跳过创建）
  const staffList = await request(ownerJar, 'GET', '/api/staff');
  if (!staffList.body.staff.some(person => person.username === STAFF_USERNAME)) {
    const created = await request(ownerJar, 'POST', '/api/staff', {
      username: STAFF_USERNAME, password: STAFF_PASSWORD
    });
    check('店主创建员工账号', created.status === 201, created.body);
  } else {
    check('员工账号已存在（沿用）', true);
  }

  // 顾客注册
  const customerJar = new Jar();
  const username = 'smoke' + Date.now().toString(36).slice(-8);
  const registered = await request(customerJar, 'POST', '/api/register', {
    username, password: CUSTOMER_PASSWORD
  });
  check('顾客自助注册并自动登录', registered.status === 201 && registered.body.authenticated === true, registered.body);
  const customerSession = await request(customerJar, 'GET', '/api/session');
  const customer = clientFor(customerJar, customerSession.body);

  // 顾客身份不得调用店主统计：客户端先拦一次，绕过客户端后服务端再拦一次
  let clientBlocked = null;
  try {
    await customer.statistics.summary({ startAt: Date.now() - 86400000, endAt: Date.now() });
  } catch (error) { clientBlocked = error.code; }
  check('客户端拦下顾客调用员工动作', clientBlocked === 'UNAUTHENTICATED', clientBlocked);

  const bypass = await request(customerJar, 'POST', '/api/action', {
    action: 'statistics.summary', data: { startAt: Date.now() - 86400000, endAt: Date.now() }
  });
  check('绕过客户端后服务端仍拒绝（FORBIDDEN）',
    bypass.status === 403 && bypass.body.error.code === 'FORBIDDEN', bypass.body);

  // 商品与购物车
  const catalog = await customer.catalog.list({ limit: 50 });
  check('读取到演示商品', catalog.items.length >= 1, catalog.items.length);
  const product = catalog.items[0];

  const cart0 = await customer.cart.get();
  await customer.cart.setLine({
    productId: product._id, quantity: 2, expectedVersion: cart0.version, requestId: rid('cart')
  });
  const cart1 = await customer.cart.get();
  check('加入购物车后数量与预估金额正确',
    cart1.items.length === 1 && cart1.items[0].quantity === 2
    && cart1.estimatedSubtotalCents === product.priceCents * 2, cart1);

  // 地址
  const addressId = 'addr-' + Date.now().toString(36);
  await customer.addresses.save({
    addressId, requestId: rid('addr'), expectedVersion: 0,
    name: '冒烟测试', phone: '13800000000', province: '北京市', city: '北京市',
    district: '朝阳区', detail: '测试路 1 号', makeDefault: true
  });
  const addresses = await customer.addresses.list({ limit: 10 });
  check('地址保存成功且标记为默认', addresses.items.length === 1 && addresses.items[0].isDefault === true, addresses.items);

  // 报价与下单
  const quote = await customer.orders.quote({
    items: cart1.items.map(item => ({ productId: item.productId, quantity: item.quantity })),
    deliveryType: 'delivery', addressId
  });
  check('配送报价包含运费字段', Number.isSafeInteger(quote.totalCents) && Number.isSafeInteger(quote.shippingCents), quote);

  const attempt = await customer.prepareCheckout({
    requestId: rid('checkout'), deliveryType: 'delivery', addressId,
    items: cart1.items.map(item => ({ productId: item.productId, quantity: item.quantity })),
    remark: '冒烟测试订单'
  });
  let order = await attempt.submit();
  check('提交订单成功（待支付）', order.status === 'PENDING_PAYMENT' && order.amounts.totalCents === quote.totalCents, order);

  const repeat = await attempt.submit();
  check('同一 requestId 重试不重复下单', repeat._id === order._id, { first: order._id, second: repeat._id });

  await customer.cart.clear({ expectedVersion: cart1.version, requestId: rid('clear') });
  const cart2 = await customer.cart.get();
  check('下单后清空购物车', cart2.items.length === 0, cart2);

  // 模拟支付
  order = await customer.orders.pay(order._id, { outcome: 'success', expectedVersion: order.version });
  check('模拟支付成功', order.status === 'PENDING_ACCEPTANCE' && order.paymentStatus === 'PAID', order.status);

  // 员工履约
  const staffJar = new Jar();
  const staffSession = await login(staffJar, STAFF_USERNAME, STAFF_PASSWORD);
  check('员工登录并取得员工会话', staffSession.staffRole === 'staff', staffSession);
  const staff = clientFor(staffJar, staffSession);

  order = await staff.fulfillment.accept({ orderId: order._id, expectedVersion: order.version, requestId: rid('accept') });
  check('员工接单', order.status === 'ACCEPTED', order.status);
  order = await staff.fulfillment.ship({
    orderId: order._id, expectedVersion: order.version, requestId: rid('ship'),
    carrier: '顺丰', trackingNo: 'SF' + Date.now().toString().slice(-10)
  });
  check('员工发货', order.status === 'SHIPPING' && order.fulfillment.trackingMode === 'MANUAL', order.status);
  order = await staff.fulfillment.complete({ orderId: order._id, expectedVersion: order.version, requestId: rid('done') });
  check('订单完成', order.status === 'COMPLETED', order.status);

  // 售后与退款
  const applied = await customer.afterSales.apply({ orderId: order._id, requestId: rid('as'), reason: '冒烟测试：商品破损' });
  check('顾客提交售后申请', applied.status === 'REQUESTED', applied.status);
  const approved = await owner.afterSales.review({
    afterSaleId: applied._id, expectedVersion: applied.version,
    requestId: rid('review'), decision: 'approve', reason: '同意退款'
  });
  check('店主审核通过', approved.status === 'APPROVED', approved.status);

  const managed = await owner.orders.list({ manage: true, limit: 50 });
  const managedOrder = managed.items.find(item => item._id === order._id);
  check('店主可查看全部订单', Boolean(managedOrder), managed.items.length);
  await owner.refunds.executeApproved({ afterSaleId: applied._id, expectedOrderVersion: managedOrder.version });
  const afterList = await owner.afterSales.list({ manage: true, limit: 50 });
  const refunded = afterList.items.find(item => item._id === applied._id);
  check('整单退款完成', refunded.status === 'REFUNDED', refunded.status);

  // 统计
  const now = Date.now();
  const summary = await owner.statistics.summary({ startAt: now - 7 * 86400000, endAt: now + 86400000 });
  check('统计包含本单收款与退款',
    summary.grossCents >= order.amounts.totalCents && summary.refundCents >= order.amounts.totalCents,
    { gross: summary.grossCents, refund: summary.refundCents, total: order.amounts.totalCents });

  // 图片上传
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const uploaded = await request(ownerJar, 'POST', '/api/upload', { contentType: 'image/png', data: png.toString('base64') });
  check('店主上传商品图片', uploaded.status === 201 && /^\/uploads\/[0-9a-f]{32}\.png$/.test(uploaded.body.url), uploaded.body);
  const fetched = await fetch(BASE + uploaded.body.url);
  check('上传后的图片可访问且类型正确',
    fetched.status === 200 && fetched.headers.get('content-type') === 'image/png', fetched.status);

  const badUpload = await request(ownerJar, 'POST', '/api/upload', {
    contentType: 'image/png', data: Buffer.from('<svg>not a png</svg>').toString('base64')
  });
  check('伪造图片类型被拒绝', badUpload.status === 415, badUpload.status);

  // 顾客不得上传
  const customerUpload = await request(customerJar, 'POST', '/api/upload', { contentType: 'image/png', data: png.toString('base64') });
  check('顾客上传被拒绝', customerUpload.status === 403, customerUpload.status);

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    username, password: CUSTOMER_PASSWORD, orderId: order._id,
    totalCents: order.amounts.totalCents, afterSaleId: applied._id
  }, null, 2));

  console.log(`\n通过 ${passed} 项检查，订单 ${order._id}`);
  console.log('状态已写入 ' + STATE_FILE + '，重启服务后可执行 verify 校验持久化。');
}

async function verify() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error('缺少冒烟状态文件，请先执行 run');
    process.exitCode = 1;
    return;
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  console.log(`重启后持久化校验：${BASE}`);

  const jar = new Jar();
  const session = await login(jar, state.username, state.password);
  check('重启后用原账号仍可登录', session.authenticated === true, session);
  const customer = clientFor(jar, session);

  const order = await customer.orders.get(state.orderId);
  check('订单在重启后仍存在', order._id === state.orderId, order._id);
  check('订单金额未变', order.amounts.totalCents === state.totalCents, order.amounts);
  check('订单已退款且在磁盘上保持一致',
    order.status === 'CANCELLED' || order.paymentStatus === 'REFUNDED' || order.status === 'COMPLETED',
    { status: order.status, paymentStatus: order.paymentStatus });

  const addressList = await customer.addresses.list({ limit: 10 });
  check('地址仍在', addressList.items.length >= 1, addressList.items.length);

  const timeline = await customer.orders.timeline({ orderId: state.orderId, limit: 50 });
  check('订单事件流水仍在', timeline.items.length >= 5, timeline.items.length);

  console.log(`\n通过 ${passed} 项检查`);
}

const mode = process.argv[2] || 'run';
(mode === 'verify' ? verify() : run()).catch(error => {
  console.error('冒烟失败：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});