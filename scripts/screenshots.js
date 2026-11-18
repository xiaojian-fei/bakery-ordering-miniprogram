'use strict';
/**
 * 生成界面截图，供报告与演示使用。
 *
 *   node scripts/screenshots.js
 *   SHOT_DIR=/tmp/shots node scripts/screenshots.js
 *
 * 依赖系统里的 chromium 与 Node 内置 WebSocket，不需要 puppeteer。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8080';
const PORT = Number(process.env.CDP_PORT || 9444);
const OUT = path.resolve(process.env.SHOT_DIR || path.join(__dirname, '..', 'docs', 'images'));
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'owner';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const CUSTOMER = { username: 'shot' + Date.now().toString(36).slice(-6), password: 'customer-pass-1234' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch (_) { /* 等待启动 */ }
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
  throw new Error('未找到页面目标');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
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
      close: () => socket.close()
    }));
    socket.addEventListener('error', reject);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message)); else res(message.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '脚本执行失败');
  return result.result.value;
}

async function shot(cdp, name) {
  await sleep(600);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  截图 ' + path.relative(path.join(__dirname, '..'), file));
}

const HELPERS = `window.__waitFor = async (fn, ms = 10000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 120)); }
  throw new Error('等待超时');
};
window.__login = async (user, pass) => {
  await __waitFor(() => document.querySelector('.auth form'));
  const inputs = document.querySelectorAll('.auth input');
  inputs[0].value = user;
  inputs[1].value = pass;
  document.querySelector('.auth form button[type=submit]').click();
};
true;`;

async function main() {
  const register = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CUSTOMER)
  });
  if (register.status !== 201) throw new Error('预置顾客账号失败');

  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync('/tmp/shot-profile-');
  const chromium = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,960', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });

  try {
    await waitDevtools();
    const cdp = await connect((await pageTarget()).webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 960, deviceScaleFactor: 1, mobile: false
    });

    console.log(`生成截图：${BASE} → ${OUT}`);

    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(1200);
    await evaluate(cdp, HELPERS);
    await evaluate(cdp, 'document.querySelector(".auth")');
    await shot(cdp, '01-登录页');

    await evaluate(cdp, `(async () => {
      await __login(${JSON.stringify(CUSTOMER.username)}, ${JSON.stringify(CUSTOMER.password)});
      await __waitFor(() => document.querySelectorAll('.product').length > 0);
    })()`);
    await shot(cdp, '02-顾客商品列表');

    await evaluate(cdp, `(async () => {
      document.querySelector('.product a.name').click();
      await __waitFor(() => document.querySelector('.qty'));
    })()`);
    await shot(cdp, '03-商品详情');

    await evaluate(cdp, `(async () => {
      const add = [...document.querySelectorAll('button')].find(b => b.textContent === '加入购物车');
      add.click();
      await __waitFor(() => document.querySelector('#nav a[href="#/cart"] .count'));
      location.hash = '#/cart';
      await __waitFor(() => document.querySelectorAll('.line-item').length > 0);
    })()`);
    await shot(cdp, '04-购物车');

    await evaluate(cdp, `(async () => {
      location.hash = '#/checkout';
      await __waitFor(() => document.querySelector('.summary .total'));
    })()`);
    await shot(cdp, '05-确认订单');

    await evaluate(cdp, `(async () => {
      location.hash = '#/addresses';
      await __waitFor(() => /收货地址/.test(document.querySelector('#main').innerText));
      const add = [...document.querySelectorAll('button')].find(b => b.textContent === '新增地址');
      add.click();
      await __waitFor(() => document.querySelector('.form-grid'));
    })()`);
    await shot(cdp, '06-收货地址');

    await evaluate(cdp, `(async () => {
      document.querySelector('#account button').click();
      await __waitFor(() => document.querySelector('.auth form'));
      await __login(${JSON.stringify(OWNER_USERNAME)}, ${JSON.stringify(OWNER_PASSWORD)});
      await __waitFor(() => location.hash.startsWith('#/owner'));
      await __waitFor(() => document.querySelectorAll('table tbody tr').length > 0);
    })()`);
    await shot(cdp, '07-店主商品与库存');

    await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => b.textContent === '经营统计').click();
      await __waitFor(() => /净额/.test(document.querySelector('#main').innerText));
    })()`);
    await shot(cdp, '08-经营统计');

    await evaluate(cdp, `(async () => {
      [...document.querySelectorAll('#main button')].find(b => b.textContent === '店铺与运费').click();
      await __waitFor(() => /运费规则/.test(document.querySelector('#main').innerText));
    })()`);
    await shot(cdp, '09-店铺与运费');

    await evaluate(cdp, `(async () => {
      location.hash = '#/staff';
      await __waitFor(() => /履约工作台/.test(document.querySelector('#main').innerText));
    })()`);
    await shot(cdp, '10-履约工作台');

    cdp.close();
    console.log('完成，共 10 张截图');
  } finally {
    chromium.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('截图失败：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});