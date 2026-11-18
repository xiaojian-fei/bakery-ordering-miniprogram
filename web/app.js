import * as auth from './views/auth.js';
import * as catalog from './views/catalog.js';
import * as cartView from './views/cart.js';
import * as addresses from './views/addresses.js';
import * as orders from './views/orders.js';
import * as staff from './views/staff.js';
import * as owner from './views/owner.js';
import { el, clear, toast, errorToast, apiError } from './ui.js';

const state = { session: null, api: null, cartCount: 0, loading: false };

const ROUTES = [
  { pattern: /^\/?$/, view: catalog, route: 'catalog', nav: '商品', open: true },
  { pattern: /^\/product\/([A-Za-z0-9_-]{1,80})$/, view: catalog, route: 'product', open: true },
  { pattern: /^\/cart$/, view: cartView, route: 'cart', nav: '购物车', badge: true },
  { pattern: /^\/checkout$/, view: cartView, route: 'checkout' },
  { pattern: /^\/addresses$/, view: addresses, route: 'addresses', nav: '收货地址' },
  { pattern: /^\/orders$/, view: orders, route: 'orders', nav: '我的订单' },
  { pattern: /^\/order\/([A-Za-z0-9_-]{1,80})$/, view: orders, route: 'order' },
  { pattern: /^\/staff$/, view: staff, route: 'staff', nav: '履约工作台', staff: true },
  { pattern: /^\/owner(?:\/([a-z-]+))?$/, view: owner, route: 'owner', nav: '店铺管理', owner: true }
];

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  return raw === '' ? '/' : raw;
}

function matchRoute() {
  const path = currentPath();
  for (const route of ROUTES) {
    const found = route.pattern.exec(path);
    if (found) return { ...route, param: found[1] || null };
  }
  return null;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function buildClient(session) {
  if (!window.Bakery || typeof window.Bakery.createTradeClient !== 'function') {
    throw new Error('客户端脚本未加载，请刷新页面');
  }
  return window.Bakery.createTradeClient({
    // 员工令牌保存在服务端 HttpOnly Cookie 中，这里只声明已具备的权限。
    staffSession: session.staffRole ? { role: session.staffRole, expiresAt: session.expiresAt } : null,
    send: async envelope => {
      const response = await fetch('/api/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope)
      });
      if (response.status === 401) onSessionLost();
      return response.json();
    }
  });
}

let losing = false;
function onSessionLost() {
  if (losing || !state.session?.authenticated) return;
  losing = true;
  state.session = { authenticated: false };
  state.api = null;
  state.cartCount = 0;
  toast('登录状态已失效，请重新登录', 'error');
  render();
  setTimeout(() => { losing = false; }, 500);
}

const ctx = {
  get api() { return state.api; },
  get session() { return state.session; },
  get isStaff() { return Boolean(state.session && state.session.staffRole); },
  get isOwner() { return Boolean(state.session && state.session.staffRole === 'owner'); },
  get cartCount() { return state.cartCount; },
  navigate(hash) {
    const target = hash.startsWith('#') ? hash : '#' + hash;
    if (location.hash === target) render();
    else location.hash = target;
  },
  async refreshSession() {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    state.session = await response.json();
    if (state.session.authenticated) {
      state.api = buildClient(state.session);
      await ctx.refreshCartCount();
    } else {
      state.api = null;
      state.cartCount = 0;
    }
    return state.session;
  },
  async refreshCartCount() {
    if (!state.api) { state.cartCount = 0; renderNav(); return 0; }
    try {
      const cart = await state.api.cart.get();
      state.cartCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    } catch (_) {
      state.cartCount = 0;
    }
    renderNav();
    return state.cartCount;
  },
  async login(username, password) {
    const { status, body } = await postJson('/api/login', { username, password });
    if (status !== 200) throw new Error(apiError(body, '登录失败'));
    state.session = { ...body, expiresAt: body.expiresAt };
    await ctx.refreshSession();
    return state.session;
  },
  async register(username, password) {
    const { status, body } = await postJson('/api/register', { username, password });
    if (status !== 201) throw new Error(apiError(body, '注册失败'));
    await ctx.refreshSession();
    return state.session;
  },
  async logout() {
    await postJson('/api/logout', {});
    state.session = { authenticated: false };
    state.api = null;
    state.cartCount = 0;
    location.hash = '#/';
    render();
  }
};

const ROLE_TEXT = { customer: '顾客', staff: '店员', owner: '店主' };

function renderNav() {
  const nav = document.getElementById('nav');
  const account = document.getElementById('account');
  clear(nav);
  clear(account);
  if (!state.session?.authenticated) return;

  const active = currentPath();
  const items = ROUTES.filter(route => route.nav);
  for (const route of items) {
    if (route.staff && !ctx.isStaff) continue;
    if (route.owner && !ctx.isOwner) continue;
    const target = route.route === 'owner' ? '#/owner' : ({ catalog: '#/', cart: '#/cart',
      addresses: '#/addresses', orders: '#/orders', staff: '#/staff' })[route.route];
    const isActive = route.route === 'owner' ? active.startsWith('/owner')
      : (route.route === 'catalog' ? active === '/' : active === target.replace(/^#/, ''));
    const link = el('a', { href: target, class: isActive ? 'active' : '' }, route.nav);
    if (route.badge && state.cartCount > 0) link.appendChild(el('span', { class: 'count' }, state.cartCount));
    nav.appendChild(link);
  }

  account.appendChild(el('span', { class: 'role-tag' },
    ROLE_TEXT[state.session.staffRole || state.session.role] || '顾客'));
  account.appendChild(el('span', {}, state.session.username || ''));
  account.appendChild(el('button', {
    class: 'ghost small',
    onclick: async () => { try { await ctx.logout(); } catch (error) { errorToast(error); } }
  }, '退出'));
}

async function render() {
  const mount = document.getElementById('main');
  const route = matchRoute();
  renderNav();

  const session = state.session;
  if (!session?.authenticated) {
    // 员工页面也要先登录，登录后按角色决定能否进入。
    if (route && (route.staff || route.owner)) history.replaceState(null, '', '#/');
    auth.render(ctx, mount);
    return;
  }
  if (!route) {
    clear(mount).appendChild(el('p', { class: 'empty' }, '页面不存在，返回 ', el('a', { href: '#/' }, '商品列表')));
    return;
  }
  if (route.staff && !ctx.isStaff) {
    toast('当前身份无权访问履约工作台', 'error');
    location.hash = '#/';
    return;
  }
  if (route.owner && !ctx.isOwner) {
    toast('当前身份无权访问店铺管理', 'error');
    location.hash = '#/';
    return;
  }
  if (state.loading) return;
  state.loading = true;
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  try {
    await route.view.render(ctx, mount, route.param, route.route);
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' },
      el('h2', {}, '页面加载失败'),
      el('p', { class: 'desc' }, error && error.message ? error.message : '请稍后重试'),
      el('button', { class: 'primary', onclick: () => render() }, '重试')));
  } finally {
    state.loading = false;
  }
}

async function boot() {
  try {
    await ctx.refreshSession();
  } catch (error) {
    errorToast(error);
  }
  window.addEventListener('hashchange', render);
  await render();
}

boot();