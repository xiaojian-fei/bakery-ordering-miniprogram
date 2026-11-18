'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const webDir = path.resolve(__dirname, '..', 'web');
const load = name => import(pathToFileURL(path.join(webDir, name)).href);

// 这些模块在顶层只做 import 与函数/常量定义，不触碰 DOM，可以在 Node 里真实加载。
// 只要有任何导出缺失或路径写错，import 就会抛错——正好覆盖"改了 ui.js 忘了导出"这类问题。
const MODULES = [
  'ui.js',
  'storage.js',
  'views/auth.js',
  'views/catalog.js',
  'views/cart.js',
  'views/addresses.js',
  'views/orders.js',
  'views/staff.js',
  'views/owner.js'
];

const EXPECTED = {
  'ui.js': ['el', 'clear', 'money', 'formatTime', 'statusBadge', 'toast', 'errorToast',
    'askConfirm', 'field', 'pageHead', 'empty', 'requestId', 'apiError', 'STATUS_TEXT', 'DELIVERY_TEXT'],
  'storage.js': ['createBrowserStorage'],
  'views/auth.js': ['render'],
  'views/catalog.js': ['render'],
  'views/cart.js': ['render'],
  'views/addresses.js': ['render'],
  'views/orders.js': ['render'],
  'views/staff.js': ['render'],
  'views/owner.js': ['render']
};

for (const name of MODULES) {
  test(`前端模块可加载且导出完整：${name}`, async () => {
    const module = await load(name);
    for (const symbol of EXPECTED[name]) {
      assert.ok(symbol in module, `${name} 缺少导出 ${symbol}`);
    }
  });
}

test('前端模块：渲染入口都是函数', async () => {
  for (const name of MODULES.filter(name => name.startsWith('views/'))) {
    const module = await load(name);
    assert.equal(typeof module.render, 'function', `${name} 的 render 必须是函数`);
  }
});

test('前端模块：ui.js 的辅助函数都是可调用的', async () => {
  const ui = await load('ui.js');
  for (const symbol of ['el', 'clear', 'money', 'formatTime', 'statusBadge', 'toast', 'errorToast',
    'askConfirm', 'field', 'pageHead', 'empty', 'requestId', 'apiError']) {
    assert.equal(typeof ui[symbol], 'function', `${symbol} 应为函数`);
  }
  assert.equal(ui.money(1250), '¥12.50');
  assert.match(ui.requestId(), /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(ui.apiError({ error: { code: 'X', message: '出错了' } }), '出错了');
  assert.equal(ui.apiError(null, '兜底'), '兜底');
});