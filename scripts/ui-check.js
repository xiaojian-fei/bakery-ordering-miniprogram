'use strict';
/**
 * 浏览器验收：用无头 Chromium + DevTools 协议真正打开页面、点按钮、检查渲染结果。
 *
 *   node scripts/ui-check.js          # 需要服务已在 SMOKE_BASE 上运行
 *
 * 只依赖 Node 内置能力（fetch + WebSocket）与系统里的 chromium，不需要 puppeteer。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const PORT = Number(process.env.CDP_PORT || 9333);
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const CUSTOMER = { username: 'ui' + Date.now().toString(36).slice(-8), password: 'customer-pass-1234' };

let passed = 0;
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log('  ✔ ' + label); return; }
  console.error('  ✖ ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  process.exitCode = 1;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return await response.json();
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
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
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
window.__waitFor = async (fn, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('等待超时');
};
window.__text = () => document.body.innerText.replace(/\\s+/g, ' ');
true;`;

async function main() {
  // 先用接口建一个顾客账号，随后在浏览器里用它登录
  const register = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CUSTOMER)
  });
  if (register.status !== 201) throw new Error('预置顾客账号失败：' + (await register.text()));

  const profile = fs.mkdtempSync('/tmp/ui-profile-');
  const chromium = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitForDevtools();
    const target = await pageTarget();
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    console.log(`浏览器验收：${BASE}`);

    // 1. 未登录首屏
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1200);
    await evaluate(cdp, HELPERS);
    const first = await evaluate(cdp, `(async () => { await __waitFor(() => document.querySelector('.auth')); return __text(); })()`);
    check('未登录时显示登录页', first.includes('登录') && first.includes('注册顾客账号'), first.slice(0, 80));

    // 2. 顾客登录后商品列表渲染出商品卡片
    await evaluate(cdp, `(async () => {
      await __waitFor(() => document.querySelector('.auth form'));
      const inputs = document.querySelectorAll('.auth input');
      inputs[0].value = ${JSON.stringify(CUSTOMER.username)};
      inputs[1].value = ${JSON.stringify(CUSTOMER.password)};
      document.querySelector('.auth form button[type=submit]').click();
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
    })()`);
    const catalog = await evaluate(cdp, `(async () => ({
      cards: document.querySelectorAll('.product').length,
      nav: document.querySelector('#nav').innerText.replace(/\\s+/g, ' '),
      account: document.querySelector('#account').innerText.replace(/\\s+/g, ' ')
    }))()`);
    check('登录后渲染商品卡片', catalog.cards >= 3, catalog.cards);
    check('顾客导航包含购物车与订单', /购物车/.test(catalog.nav) && /我的订单/.test(catalog.nav), catalog.nav);
    check('顶栏显示顾客身份', /顾客/.test(catalog.account), catalog.account);

    // 3. 加入购物车，购物车页面出现该商品
    const added = await evaluate(cdp, `(async () => {
      const button = [...document.querySelectorAll('.product button')].find(b => b.textContent === '加入购物车');
      button.click();
      await __waitFor(() => /购物车/.test(document.querySelector('#toast').textContent)
        || document.querySelector('#nav a[href="#/cart"] .count'));
      document.querySelector('#nav a[href="#/cart"]').click();
      await __waitFor(() => document.querySelectorAll('.line-item').length > 0);
      return {
        items: document.querySelectorAll('.line-item').length,
        text: __text(),
        badge: (document.querySelector('#nav a[href="#/cart"] .count') || {}).textContent || ''
      };
    })()`);
    check('加入购物车后购物车页显示条目', added.items >= 1, added.items);
    check('购物车显示小计与结算入口', added.text.includes('去结算'), added.text.slice(0, 120));
    check('导航购物车角标已更新', added.badge !== '', added.badge);

    // 4. 结算页报价能算出来
    const checkout = await evaluate(cdp, `(async () => {
      document.querySelector('#main button.primary').click();
      await __waitFor(() => document.querySelectorAll('.summary .total').length > 0);
      return { text: __text(), total: document.querySelector('.summary .total').innerText };
    })()`);
    check('结算页显示应付总额', /应付总额/.test(checkout.total), checkout.total);
    check('结算页提供履约方式选择', /配送/.test(checkout.text) && /到店自取/.test(checkout.text), '');

    // 5. 店主登录后进入店铺管理，商品表格可见
    await evaluate(cdp, `(async () => {
      document.querySelector('#account button').click();
      await __waitFor(() => document.querySelector('.auth form'));
      const inputs = document.querySelectorAll('.auth input');
      inputs[0].value = ${JSON.stringify(OWNER_USERNAME)};
      inputs[1].value = ${JSON.stringify(OWNER_PASSWORD)};
      document.querySelector('.auth form button[type=submit]').click();
      await __waitFor(() => location.hash.startsWith('#/owner'));
      await __waitFor(() => document.querySelectorAll('table tbody tr').length > 0);
    })()`);
    const owner = await evaluate(cdp, `(async () => ({
      hash: location.hash,
      rows: document.querySelectorAll('table tbody tr').length,
      nav: document.querySelector('#nav').innerText.replace(/\\s+/g, ' '),
      account: document.querySelector('#account').innerText.replace(/\\s+/g, ' '),
      text: __text()
    }))()`);
    check('店主登录后进入店铺管理', owner.hash.startsWith('#/owner'), owner.hash);
    check('商品与库存表格渲染', owner.rows >= 3, owner.rows);
    check('店主可见履约与店铺管理导航', /履约工作台/.test(owner.nav) && /店铺管理/.test(owner.nav), owner.nav);
    check('店主可见统计与员工标签页', /经营统计/.test(owner.text) && /员工账号/.test(owner.text), '');

    // 6. 切到统计标签，能出数字
    const stats = await evaluate(cdp, `(async () => {
      const tab = [...document.querySelectorAll('#main button')].find(b => b.textContent === '经营统计');
      tab.click();
      await __waitFor(() => /净额/.test(document.querySelector('#main').innerText));
      return __text();
    })()`);
    check('经营统计渲染金额指标', /收款/.test(stats) && /净额/.test(stats), stats.slice(0, 100));

    // 7. 顾客访问店铺管理应被拦下
    const blocked = await evaluate(cdp, `(async () => {
      document.querySelector('#account button').click();
      await __waitFor(() => document.querySelector('.auth form'));
      const inputs = document.querySelectorAll('.auth input');
      inputs[0].value = ${JSON.stringify(CUSTOMER.username)};
      inputs[1].value = ${JSON.stringify(CUSTOMER.password)};
      document.querySelector('.auth form button[type=submit]').click();
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
      location.hash = '#/owner';
      await __waitFor(() => location.hash === '#/' || !location.hash.startsWith('#/owner'), 5000).catch(() => null);
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