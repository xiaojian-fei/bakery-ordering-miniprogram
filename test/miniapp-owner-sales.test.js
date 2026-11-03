'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApplication } = require('../cloudfunctions/api/application');
const { createTradeClient } = require('../services/trade-client');
const { createMiniappRuntime } = require('../services/miniapp-runtime');
const { authFixture, DEMO_PASSWORD } = require('./support/auth-fixture');
const { miniappHarness } = require('./support/miniapp-harness');

const route = 'pages/admin/after-sales/after-sales';
const event = dataset => ({ currentTarget: { dataset } });

async function fixture() {
  const base = await authFixture();
  base.setTime(Date.now());
  const app = createApplication({ repository: base.repository, clock: base.clock, resolveIdentity: async openid => ({ openid }) });
  const writes = [];
  let lost = '', seq = 0;
  const runtime = subjectId => createMiniappRuntime({ subjectId, requestId: () => 'owner-sales-' + (++seq),
    client: createTradeClient({ clock: base.clock, send: async request => {
      if (['afterSales.review', 'refunds.executeApproved', 'catalog.save', 'inventory.adjust'].includes(request.action)) {
        writes.push(structuredClone(request.data));
      }
      const response = await app.handle(request, subjectId);
      if (lost === request.action) { lost = ''; throw new Error('response lost'); }
      return response;
    } }) });
  const buyer = runtime('buyer-demo'), owner = runtime('owner-demo'), staff = runtime('staff-demo');
  await owner.client.staff.login(DEMO_PASSWORD);
  await staff.client.staff.login(DEMO_PASSWORD);
  const order = await buyer.client.orders.create({ requestId: 'owner-sales-order', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 1 }] });
  await buyer.client.orders.pay(order._id);
  const sale = await buyer.client.afterSales.apply({ orderId: order._id, reason: '商品损坏', requestId: 'owner-sales-apply' });
  const ui = miniappHarness(owner), page = ui.loadPage(route);
  await page.onShow();
  async function choose(action, confirm = true, target = ui) {
    const count = target.events.length;
    const work = action();
    for (let i = 0; i < 20 && target.events.length === count; i++) await new Promise(resolve => setImmediate(resolve));
    const dialog = target.events.at(-1);
    assert.equal(dialog.name, 'showModal');
    dialog.options.success({ confirm });
    await work;
  }
  return { ...base, buyer, owner, staff, page, sale, order, choose, writes, lost: action => { lost = action; } };
}

test('售后管理：店主审批与退款分开，退款响应丢失时重试只保留一笔退款', async () => {
  const { buyer, page, sale, order, choose, lost, repository } = await fixture();
  page.openReview(event({ id: sale._id }));
  page.enterReviewReason({ detail: { value: '确认破损' } });
  await choose(() => page.submitReview(event({ decision: 'approve' })));
  assert.equal(page.data.rows[0].status, 'APPROVED');
  assert.equal((await buyer.client.orders.get(order._id)).paymentStatus, 'PAID');
  lost('refunds.executeApproved');
  await choose(() => page.refundSale(event({ id: sale._id })));
  assert.equal(page.data.pending, true);
  await page.retrySaleWrite();
  assert.equal(page.data.pending, false);
  assert.equal(page.data.rows[0].status, 'REFUNDED');
  assert.equal(Object.keys(repository.snapshot().refunds).length, 1);
  assert.equal((await buyer.client.afterSales.get(sale._id)).status, 'REFUNDED');
});

test('商品管理：新增商品价格按分保存，调库存独立处理且下架商品对顾客隐藏', async () => {
  const { buyer, owner, choose, writes } = await fixture();
  const ui = miniappHarness(owner), page = ui.loadPage('pages/admin/catalog/catalog');
  const field = (key, value) => page.editProductField({ ...event({ key }), detail: { value } });
  await page.onShow();
  page.newProduct();
  field('name', '测试新品'); field('price', '19.90');
  await choose(() => page.submitProduct(), true, ui);
  const product = page.data.rows.find(row => row.name === '测试新品');
  assert.equal(product.priceCents, 1990);
  assert.equal(product.onHand, 0);
  assert.equal('onHand' in writes[0], false);
  assert.equal((await buyer.client.catalog.list()).items.some(row => row._id === product._id), false);
  page.editProduct(event({ id: product._id, type: 'stock' }));
  field('onHand', '6'); field('reason', '新品入库');
  await choose(() => page.submitProduct(), true, ui);
  page.editProduct(event({ id: product._id, type: 'catalog' }));
  field('isOnSale', true);
  await choose(() => page.submitProduct(), true, ui);
  const visible = await buyer.client.catalog.get(product._id);
  assert.equal(visible.available, 6);
  assert.equal(visible.priceCents, 1990);
});

test('商品管理：库存响应丢失可复用原请求，已预留商品不可被调减到预留量以下', async () => {
  const { buyer, owner, choose, lost, writes } = await fixture();
  await buyer.client.orders.create({ requestId: 'catalog-reserve-01', deliveryType: 'pickup',
    items: [{ productId: 'bread', quantity: 2 }] });
  const ui = miniappHarness(owner), page = ui.loadPage('pages/admin/catalog/catalog');
  const field = (key, value) => page.editProductField({ ...event({ key }), detail: { value } });
  await page.onShow();
  page.editProduct(event({ id: 'bread', type: 'stock' }));
  field('onHand', '1'); field('reason', '盘点');
  await page.submitProduct();
  assert.equal(writes.length, 0);
  assert.match(page.data.error, /预留/);
  field('onHand', '7');
  lost('inventory.adjust');
  await choose(() => page.submitProduct(), true, ui);
  assert.equal(page.data.pending, true);
  await page.retryProduct();
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(page.data.rows[0].onHand, 7);
  assert.equal(page.data.rows[0].reserved, 2);
});

test('售后管理：取消审核不发送写入，驳回响应丢失后复用审核请求', async () => {
  const { page, sale, choose, lost, writes } = await fixture();
  page.openReview(event({ id: sale._id }));
  page.enterReviewReason({ detail: { value: '材料不完整' } });
  await choose(() => page.submitReview(event({ decision: 'reject' })), false);
  assert.equal(writes.length, 0);
  lost('afterSales.review');
  await choose(() => page.submitReview(event({ decision: 'reject' })));
  await page.retrySaleWrite();
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(page.data.rows[0].status, 'REJECTED');
  assert.equal(page.data.rows[0].reviewReason, '材料不完整');
});

test('售后管理：员工直接打开页面及店主退出后均无法查看售后', async () => {
  const { staff, owner, page } = await fixture();
  const staffPage = miniappHarness(staff).loadPage(route);
  await staffPage.onShow();
  assert.equal(staffPage.data.rows.length, 0);
  assert.ok(staffPage.data.error);
  owner.client.clearSession();
  await page.refreshSales();
  assert.equal(page.data.rows.length, 0);
  assert.ok(page.data.error);
});

test('经营统计：按北京时间分段，员工无权读取，店主查看模拟收款', async () => {
  const { owner, staff } = await fixture();
  const path = 'pages/admin/statistics/statistics';
  const page = miniappHarness(owner).loadPage(path);
  await page.onShow();
  assert.equal(page.data.summary.gross, '12.50');
  assert.equal(page.data.summary.net, '12.50');
  assert.equal(page.data.summary.start, page.data.summary.end);
  await page.changePeriod({ detail: { value: '1' } });
  assert.notEqual(page.data.summary.start, page.data.summary.end);
  assert.equal(page.data.summary.paid, 1);
  const staffPage = miniappHarness(staff).loadPage(path);
  await staffPage.onShow();
  assert.equal(staffPage.data.summary, null);
  assert.ok(staffPage.data.error);
});
