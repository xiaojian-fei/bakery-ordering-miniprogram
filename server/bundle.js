'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// 浏览器与 Node 共用同一份交易客户端：这里只做最小 CommonJS 包装，
// 不引入打包器，也就不需要任何前端构建步骤或 npm 依赖。
const MODULES = Object.freeze([
  'trade-errors',
  'checkout-attempt',
  'trade-client',
  'operation-recovery',
  'checkout-recovery',
  'fulfillment-recovery',
  'after-sale-recovery'
]);

const EXPORTS = Object.freeze({
  createTradeClient: ['./trade-client', 'createTradeClient'],
  TradeApiError: ['./trade-client', 'TradeApiError'],
  createCheckoutRecovery: ['./checkout-recovery', 'createCheckoutRecovery']
});

async function buildClientBundle(root) {
  const sources = await Promise.all(MODULES.map(async name => {
    const code = await fs.readFile(path.join(root, 'shared', name + '.js'), 'utf8');
    return `${JSON.stringify('./' + name)}: function(module, require) {\n${code}\n}`;
  }));
  const exposed = Object.entries(EXPORTS)
    .map(([name, [id, key]]) => `window.Bakery.${name}=require(${JSON.stringify(id)}).${key};`)
    .join('');
  return '/* 由 server/bundle.js 从 shared/ 生成；与 Node 端运行同一份客户端源码。 */\n'
    + '(function(){\n"use strict";\n'
    + `var definitions={${sources.join(',\n')}};\n`
    + 'var cache={};\n'
    + 'function require(id){if(!cache[id]){var module={exports:{}};cache[id]=module;definitions[id](module,require);}return cache[id].exports;}\n'
    + 'window.Bakery={};\n'
    + exposed
    + '\n})();\n';
}

module.exports = { buildClientBundle, MODULES };