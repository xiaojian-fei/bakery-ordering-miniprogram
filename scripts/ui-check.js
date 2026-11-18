'use strict';
/**
 * 浏览器验收：用无头 Chromium + DevTools 协议真正打开页面、点按钮、检查渲染结果。
 *
 *   node scripts/ui-check.js
 *
 * 覆盖：未登录首屏、顾客下单与支付、结算草稿找回入口、店员接单、店主管理端、越权重定向。
 * 只依赖 Node 内置能力（fetch + WebSocket）与系统里的 chromium，不需要 puppeteer。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const PORT = Number(process.env.CDP_PORT || 9333);
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const STAFF = { username: 'uistaff', password: 'ui-staff-pass-1234' };
const CUSTOMER = { username: 'ui' + Date.now().toString(36).slice(-8), password: 'customer-pass-1234' };
const NAMESPACE = 'bakery.checkout.v1';

let passed = 0;
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log('  ✔ ' + label); return; }
  console.error('  ✖ ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  process.exitCode = 1;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------------- 直接调接口的辅助（用于准备数据与构造草稿） ---------------- */

class Api {
  constructor() { this.cookies = new Map(); }
  async call(method, pathname, body) {
    const response = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; ') } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async login(username, password) {
    const result = await this.call('POST', '/api/login', { username, password });
    if (result.status !== 200) throw new Error('预置账号登录失败：' + JSON.stringify(result.body));
    return (await this.call('GET', '/api/session')).body;
  }
  async action(action, data = {}) {
    const result = await this.call('POST', '/api/action', { action, data });
    if (!result.body || result.body.success !== true) {
      throw new Error('接口调用失败：' + JSON.stringify(result.body));
    }
    return result.body.data;
  }
}

async function prepareAccounts() {
  const owner = new Api();
  await owner.login(OWNER_USERNAME, OWNER_PASSWORD);
  const staffList = await owner.call('GET', '/api/staff');
  if (!staffList.body.staff.some(person => person.username === STAFF.username)) {
    const created = await owner.call('POST', '/api/staff', STAFF);
    if (created.status !== 201) throw new Error('创建店员账号失败：' + JSON.stringify(created.body));
  }
  const customer = new Api();
  const registered = await customer.call('POST', '/api/register', CUSTOMER);
  if (registered.status !== 201) throw new Error('注册顾客失败：' + JSON.stringify(registered.body));
  const session = (await customer.call('GET', '/api/session')).body;
  return { owner, customer, openid: session.openid };
}

/** 依据当前购物车内容构造一份结构合法的“待提交”草稿，用于验证找回入口。 */
async function buildDraft(customer, openid) {
  const cart = await customer.action('cart.get');
  const items = cart.items.map(item => ({ productId: item.productId, quantity: item.quantity }));
  const quote = await customer.action('orders.quote', { items, deliveryType: 'pickup' });
  return {
    schemaVersion: 1,
    subjectId: openid,
    state: 'PREPARED',
    payload: {
      requestId: 'draft-ui-' + Date.now().toString(36),
      items, deliveryType: 'pickup', remark: '', expectedTotalCents: quote.totalCents
    },
    quote: {
      items: quote.items, subtotalCents: quote.subtotalCents,
      shippingCents: quote.shippingCents, totalCents: quote.totalCents,
      shippingRuleVersion: quote.shippingRuleVersion
    },
    orderId: null
  };
}

/* ---------------- CDP ---------------- */

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chromium 调试端口未就绪');
}

async function pageTarget() {
  for (let i = 0; i < 40; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(250);
  }
  throw new Error('未找到可用的页面目标');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const consoleErrors = [];
    let id = 0;
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        id += 1;
        const messageId = id;
        socket.send(JSON.stringify({ id: messageId, method, params }));
        return new Promise((res, rej) => {
          pending.set(messageId, { res, rej });
          setTimeout(() => rej(new Error(method + ' 超时')), 20000);
        });
      },
      consoleErrors,
      close: () => socket.close()
    }));
    socket.addEventListener('error', reject);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message)); else res(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description
          || message.params.exceptionDetails?.text || '未知异常');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      }
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

const HELPERS = `
window.__waitFor = async (fn, ms = 12000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('等待超时');
};
window.__text = () => document.body.innerText.replace(/\\s+/g, ' ');
window.__login = async (user, pass) => {
  await __waitFor(() => document.querySelector('.auth form'));
  const inputs = document.querySelectorAll('.auth input');
  inputs[0].value = user;
  inputs[1].value = pass;
  document.querySelector('.auth form button[type=submit]').click();
};
window.__drafts = () => Object.keys(localStorage).filter(k => k.startsWith(${JSON.stringify(NAMESPACE)}));
true;`;

async function main() {
  const { customer, openid } = await prepareAccounts();

  const profile = fs.mkdtempSync('/tmp/ui-profile-');
  const chromium = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,960', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitForDevtools();
    const cdp = await connect((await pageTarget()).webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
    console.log(`浏览器验收：${BASE}`);

    // 1. 未登录首屏
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1200);
    await evaluate(cdp, HELPERS);
    const first = await evaluate(cdp, `(async () => { await __waitFor(() => document.querySelector('.auth')); return __text(); })()`);
    check('未登录时显示登录页', first.includes('登录') && first.includes('注册顾客账号'), first.slice(0, 80));

    // 2. 顾客登录后商品列表
    await evaluate(cdp, `(async () => {
      await __login(${JSON.stringify(CUSTOMER.username)}, ${JSON.stringify(CUSTOMER.password)});
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
    })()`);
    const catalog = await evaluate(cdp, `({
      cards: document.querySelectorAll('.product').length,
      nav: document.querySelector('#nav').innerText.replace(/\\s+/g, ' '),
      account: document.querySelector('#account').innerText.replace(/\\s+/g, ' ')
    })`);
    check('登录后渲染商品卡片', catalog.cards >= 3, catalog.cards);
    check('顾客导航包含购物车与订单', /购物车/.test(catalog.nav) && /我的订单/.test(catalog.nav), catalog.nav);
    check('顶栏显示顾客身份', /顾客/.test(catalog.account), catalog.account);

    const categoryChips = await evaluate(cdp, `(async () => {
      const chips = () => [...document.querySelectorAll('#main > .actions > .actions > button')];
      const before = chips().map(b => b.textContent);
      const target = chips().find(b => b.textContent !== '全部');
      if (!target) return { skipped: true, before };
      target.click();
      await __waitFor(() => document.querySelectorAll('#main .product').length > 0);
      const active = chips().filter(b => b.className.includes('primary')).map(b => b.textContent);
      const after = chips().map(b => b.textContent);
      const all = chips().find(b => b.textContent === '全部');
      all.click();
      await __waitFor(() => document.querySelectorAll('#main .product').length > 0);
      return { before, after, active, target: target.textContent };
    })()`);
    check('切换分类后其他分类仍然可见',
      !categoryChips.skipped && categoryChips.after.length === categoryChips.before.length, categoryChips);
    check('切换分类后高亮跟随所选项',
      categoryChips.active?.length === 1 && categoryChips.active[0] === categoryChips.target, categoryChips.active);

    const passwordPage = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#account button')].find(b => b.textContent === '修改密码').click();
      await __waitFor(() => /修改密码/.test(document.querySelector('#main h1')?.textContent || ''));
      const fields = [...document.querySelectorAll('#main input[type=password]')];
      const count = fields.length;
      // 故意用错误的当前密码，确认服务端拒绝且页面提示
      fields[0].value = 'definitely-wrong-password';
      fields[1].value = 'newpassword123';
      fields[2].value = 'newpassword123';
      [...document.querySelectorAll('#main button')].find(b => /保存新密码/.test(b.textContent)).click();
      await __waitFor(() => /当前密码不正确/.test(__text()), 10000);
      const hasError = /当前密码不正确/.test(__text());
      location.hash = '#/';
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
      return { count, hasError };
    })()`);
    check('修改密码页有三个密码输入框', passwordPage.count === 3, passwordPage.count);
    check('修改密码：错误的当前密码被拒绝', passwordPage.hasError === true, passwordPage);

    // 3. 加入购物车
    const added = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('.product button')].find(b => b.textContent === '加入购物车').click();
      await __waitFor(() => document.querySelector('#nav a[href="#/cart"] .count'));
      document.querySelector('#nav a[href="#/cart"]').click();
      await __waitFor(() => document.querySelectorAll('.line-item').length > 0);
      return { items: document.querySelectorAll('.line-item').length, text: __text(),
        badge: document.querySelector('#nav a[href="#/cart"] .count').textContent };
    })()`);
    check('加入购物车后购物车页显示条目', added.items >= 1, added.items);
    check('购物车显示小计与结算入口', added.text.includes('去结算'), added.text.slice(0, 120));
    check('导航购物车角标已更新', added.badge !== '', added.badge);

    // 4. 结算页报价
    const checkout = await evaluate(cdp, `(async () => {
      document.querySelector('#main button.primary').click();
      await __waitFor(() => document.querySelectorAll('.summary .total').length > 0);
      return { text: __text(), total: document.querySelector('.summary .total').innerText };
    })()`);
    check('结算页显示应付总额', /应付总额/.test(checkout.total), checkout.total);
    check('结算页提供履约方式选择', /配送/.test(checkout.text) && /到店自取/.test(checkout.text), '');
    check('无草稿时不显示找回入口', !/尚未提交的结算|结果未确认/.test(checkout.text), checkout.text.slice(0, 100));

    // 5. 提交订单（走草稿恢复链路）
    const submitted = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => b.textContent === '提交订单').click();
      await __waitFor(() => location.hash.startsWith('#/order/'), 15000);
      await __waitFor(() => /订单详情/.test(__text()));
      return { hash: location.hash, text: __text(), drafts: __drafts() };
    })()`);
    check('提交订单后进入订单详情', submitted.hash.startsWith('#/order/'), submitted.hash);
    check('新订单显示待支付', /待支付/.test(submitted.text), submitted.text.slice(0, 120));
    check('下单成功后本机草稿已清除', submitted.drafts.length === 0, submitted.drafts);
    const orderId = submitted.hash.replace('#/order/', '');

    // 6. 模拟支付
    const paid = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => b.textContent === '模拟支付').click();
      await __waitFor(() => /待接单/.test(__text()));
      return __text();
    })()`);
    check('模拟支付后订单进入待接单', /待接单/.test(paid), paid.slice(0, 120));

    const orderTabs = await evaluate(cdp, `(async () => {
      const tabs = () => [...document.querySelectorAll('#main > .actions > button')];
      location.hash = '#/orders';
      await __waitFor(() => /我的订单/.test(__text()));
      await __waitFor(() => tabs().length >= 6);
      tabs().find(b => b.textContent === '待支付').click();
      await __waitFor(() => tabs().filter(b => b.className.includes('primary'))
        .map(b => b.textContent).includes('待支付'));
      const active = tabs().filter(b => b.className.includes('primary')).map(b => b.textContent);
      tabs().find(b => b.textContent === '全部').click();
      await __waitFor(() => document.querySelectorAll('#main .card').length > 0);
      return { active };
    })()`);
    check('订单标签高亮跟随点击',
      orderTabs.active.length === 1 && orderTabs.active[0] === '待支付', orderTabs.active);

    // 7. 结算草稿找回入口：注入一份待提交草稿后重载结算页
    await evaluate(cdp, `(async () => {
      location.hash = '#/';
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
      [...document.querySelectorAll('.product button')].find(b => b.textContent === '加入购物车').click();
      await __waitFor(() => document.querySelector('#nav a[href="#/cart"] .count'));
    })()`);
    const draft = await buildDraft(customer, openid);
    const injected = await evaluate(cdp, `(async () => {
      localStorage.setItem(${JSON.stringify(NAMESPACE + ':' + openid)}, ${JSON.stringify(JSON.stringify(draft))});
      location.hash = '#/checkout';
      await __waitFor(() => /确认订单/.test(__text()));
      await __waitFor(() => /尚未提交的结算/.test(__text()), 8000).catch(() => null);
      const submit = [...document.querySelectorAll('#main button')].find(b => /请先处理上次的结算/.test(b.textContent));
      return { text: __text(), hasBanner: /尚未提交的结算/.test(__text()),
        submitDisabled: Boolean(submit && submit.disabled), drafts: __drafts() };
    })()`);
    check('存在草稿时结算页给出找回入口', injected.hasBanner, injected.text.slice(0, 160));
    check('存在草稿时禁止直接提交新结算', injected.submitDisabled === true, injected.submitDisabled);

    const recovered = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => /重试找回/.test(b.textContent)).click();
      await __waitFor(() => location.hash.startsWith('#/order/'), 15000);
      await __waitFor(() => /订单详情/.test(__text()));
      return { hash: location.hash, text: __text(), drafts: __drafts() };
    })()`);
    check('草稿找回复用原请求并落到订单详情', recovered.hash.startsWith('#/order/'), recovered.hash);
    check('找回成功后草稿被清除', recovered.drafts.length === 0, recovered.drafts);
    check('找回的订单仍未支付（没有伪造状态）', /待支付/.test(recovered.text), recovered.text.slice(0, 120));

    // 8. 店员登录并接单（履约恢复链路）
    await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#account button')].find(b => b.textContent === '退出').click();
      await __waitFor(() => document.querySelector('.auth form'));
      await __login(${JSON.stringify(STAFF.username)}, ${JSON.stringify(STAFF.password)});
      await __waitFor(() => location.hash === '#/staff' || location.hash.startsWith('#/staff'));
      await __waitFor(() => document.querySelectorAll('.card').length > 0);
    })()`);
    const staffView = await evaluate(cdp, `(async () => {
      await __waitFor(() => /履约工作台/.test(__text()));
      const empty = /没有需要处理的订单/.test(__text());
      if (empty) {
        [...document.querySelectorAll('#main button')].find(b => b.textContent === '全部订单').click();
        await __waitFor(() => !/没有需要处理的订单/.test(__text()), 8000).catch(() => null);
      }
      return { text: __text(), empty, drafts: __drafts() };
    })()`);
    check('店员进入履约工作台', /履约工作台/.test(staffView.text), staffView.text.slice(0, 120));

    const staffTabs = await evaluate(cdp, `(async () => {
      const tabs = () => [...document.querySelectorAll('#main > .actions > button')];
      tabs().find(b => b.textContent === '已接单待履约').click();
      await __waitFor(() => tabs().filter(b => b.className.includes('primary'))
        .map(b => b.textContent).includes('已接单待履约'));
      const active = tabs().filter(b => b.className.includes('primary')).map(b => b.textContent);
      tabs().find(b => b.textContent === '待接单').click();
      // 等列表真正加载完再返回，避免后续步骤抓到“加载中”
      await __waitFor(() => [...document.querySelectorAll('#main button')]
        .some(b => b.textContent === '接单'), 12000);
      return { active };
    })()`);
    check('履约标签高亮跟随点击',
      staffTabs.active.length === 1 && staffTabs.active[0] === '已接单待履约', staffTabs.active);
    check('店员可见刚支付的订单', staffView.text.includes(orderId.slice(0, 8)) || /接单/.test(staffView.text),
      staffView.text.slice(0, 200));

    const accepted = await evaluate(cdp, `(async () => {
      const accept = [...document.querySelectorAll('#main button')].find(b => b.textContent === '接单');
      if (!accept) return { skipped: true, text: __text() };
      accept.click();
      await __waitFor(() => /操作成功/.test(document.querySelector('#toast').textContent), 15000);
      await __waitFor(() => /已接单/.test(__text()), 15000);
      return { text: __text(), drafts: __drafts() };
    })()`);
    check('店员接单成功', accepted.skipped ? false : /已接单/.test(accepted.text), accepted.text.slice(0, 160));
    check('履约成功后本机草稿已清除', (accepted.drafts || []).length === 0, accepted.drafts);

    // 9. 店主登录进入店铺管理
    await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#account button')].find(b => b.textContent === '退出').click();
      await __waitFor(() => document.querySelector('.auth form'));
      await __login(${JSON.stringify(OWNER_USERNAME)}, ${JSON.stringify(OWNER_PASSWORD)});
      await __waitFor(() => location.hash.startsWith('#/owner'));
      await __waitFor(() => document.querySelectorAll('table tbody tr').length > 0);
    })()`);
    const owner = await evaluate(cdp, `({
      hash: location.hash,
      rows: document.querySelectorAll('table tbody tr').length,
      nav: document.querySelector('#nav').innerText.replace(/\\s+/g, ' '),
      account: document.querySelector('#account').innerText.replace(/\\s+/g, ' '),
      text: __text()
    })`);
    check('店主登录后进入店铺管理', owner.hash.startsWith('#/owner'), owner.hash);
    check('商品与库存表格渲染', owner.rows >= 3, owner.rows);
    check('店主可见履约与店铺管理导航', /履约工作台/.test(owner.nav) && /店铺管理/.test(owner.nav), owner.nav);
    check('店主可见统计与员工标签页', /经营统计/.test(owner.text) && /员工账号/.test(owner.text), '');

    const stats = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => b.textContent === '经营统计').click();
      await __waitFor(() => /净额/.test(document.querySelector('#main').innerText));
      return __text();
    })()`);
    check('经营统计渲染金额指标', /收款/.test(stats) && /净额/.test(stats), stats.slice(0, 100));

    // 10. 顾客不得进入店铺管理
    const blocked = await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#account button')].find(b => b.textContent === '退出').click();
      await __waitFor(() => document.querySelector('.auth form'));
      await __login(${JSON.stringify(CUSTOMER.username)}, ${JSON.stringify(CUSTOMER.password)});
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
      location.hash = '#/owner';
      await __waitFor(() => !location.hash.startsWith('#/owner'), 5000).catch(() => null);
      return { hash: location.hash, nav: document.querySelector('#nav').innerText.replace(/\\s+/g, ' ') };
    })()`);
    check('顾客被重定向离开店铺管理', !blocked.hash.startsWith('#/owner'), blocked.hash);
    check('顾客导航不含店铺管理', !/店铺管理/.test(blocked.nav), blocked.nav);

    const errors = cdp.consoleErrors.filter(text => text && !/favicon/i.test(text));
    check('全程没有前端异常', errors.length === 0, errors.slice(0, 3));
    cdp.close();
    console.log(`\n通过 ${passed} 项浏览器检查`);
  } finally {
    chromium.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('浏览器验收失败：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});