'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

// 执行真实App/Page/Component入口与生命周期，不模拟WXML渲染或微信编译器。
function miniappHarness(runtime, { legacyCloud = false } = {}) {
  const events = [], pages = [], components = [], cache = new Map();
  let app, cloudReads = 0;
  const wx = Object.fromEntries(['showToast', 'showModal', 'navigateTo', 'switchTab', 'makePhoneCall', 'setClipboardData']
    .map(name => [name, options => { events.push({ name, options }); }]));
  Object.defineProperty(wx, 'cloud', { get() {
    cloudReads += 1;
    if (!legacyCloud) throw new Error('UNEXPECTED_CLOUD_ACCESS');
    return { database: () => ({}) };
  } });
  const context = vm.createContext({ wx, console,
    getApp: () => app,
    getCurrentPages: () => pages,
    App: definition => { app = definition; },
    Page: definition => {
      const page = { ...definition, data: structuredClone(definition.data || {}), updates: [],
        setData(value) { this.updates.push(structuredClone(value)); Object.assign(this.data, structuredClone(value)); } };
      pages.push(page);
    },
    Component: definition => { components.push(definition); }
  });
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (filename === path.join(root, 'services', 'miniapp-config.js')) return runtime;
    if (cache.has(filename)) return cache.get(filename).exports;
    // 不依赖原生全局的共享服务直接使用同一Node模块，保留TradeApiError类型身份。
    if (filename.includes(path.sep + 'services' + path.sep) && !filename.endsWith('miniapp-entry.js')) return require(filename);
    const module = { exports: {} }; cache.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    const run = new vm.Script('(function(require,module,exports){\n' + source + '\n})', { filename }).runInContext(context);
    run(specifier => {
      if (!specifier.startsWith('.')) throw new Error('UNEXPECTED_NATIVE_DEPENDENCY');
      return load(path.relative(root, path.resolve(path.dirname(filename), specifier + '.js')));
    }, module, module.exports);
    return module.exports;
  }
  load('app.js');
  return { wx, events, pages, components, app, load,
    loadPage: route => { load(route + '.js'); return pages[pages.length - 1]; },
    cloudReads: () => cloudReads };
}
module.exports = { miniappHarness };
