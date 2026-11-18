// 轻量 DOM 与提示工具。刻意不引入框架：整个前端零依赖、零构建步骤。

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const money = cents => '¥' + (Number(cents || 0) / 100).toFixed(2);

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const STATUS_TEXT = Object.freeze({
  PENDING_PAYMENT: '待支付',
  PENDING_ACCEPTANCE: '待接单',
  ACCEPTED: '已接单',
  SHIPPING: '配送中',
  READY_FOR_PICKUP: '待自取',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已超时'
});

const STATUS_TONE = Object.freeze({
  PENDING_PAYMENT: 'pending',
  PENDING_ACCEPTANCE: 'pending',
  ACCEPTED: 'active',
  SHIPPING: 'active',
  READY_FOR_PICKUP: 'active',
  COMPLETED: 'done',
  CANCELLED: 'dead',
  EXPIRED: 'dead'
});

export function statusBadge(status) {
  return el('span', { class: 'status ' + (STATUS_TONE[status] || '') }, STATUS_TEXT[status] || status);
}

export const DELIVERY_TEXT = Object.freeze({ delivery: '配送', pickup: '自取' });

let toastTimer = null;
export function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  if (!box) return;
  box.textContent = message;
  box.className = 'toast show' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, kind === 'error' ? 5200 : 2600);
}

/** 错误一律用客户端 SDK 给出的中文文案，不把原始响应或堆栈显示给用户。 */
export function errorToast(error) {
  const message = error && typeof error.message === 'string' && error.message ? error.message : '操作未完成，请稍后重试';
  toast(message, 'error');
  return message;
}

export function askConfirm(message, { title = '请确认', confirmText = '确定', cancelText = '取消' } = {}) {
  const dialog = document.getElementById('dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(message));
  clear(dialog);
  let settle = () => {};
  const done = value => { if (dialog.open) dialog.close(); settle(value); };
  dialog.appendChild(el('h2', {}, title));
  dialog.appendChild(el('p', {}, message));
  dialog.appendChild(el('div', { class: 'actions' },
    el('button', { class: 'primary', onclick: () => done(true) }, confirmText),
    el('button', { onclick: () => done(false) }, cancelText)));
  const promise = new Promise(resolve => { settle = resolve; });
  dialog.addEventListener('close', () => settle(false), { once: true });
  dialog.showModal();
  return promise;
}

export function field(labelText, control, hint) {
  const wrapper = el('label', { class: 'field' }, el('span', {}, labelText), control);
  if (hint) wrapper.appendChild(el('small', { class: 'desc' }, hint));
  return wrapper;
}

export function pageHead(title, subtitle, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, title), subtitle ? el('p', {}, subtitle) : null),
    actions.length ? el('div', { class: 'actions' }, ...actions) : null);
}

export const empty = text => el('p', { class: 'empty' }, text);

export function requestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/** 用统一忙碌态包裹异步点击：执行期间禁用按钮，避免重复提交。 */
export function busy(button, work) {
  return async (...args) => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      return await work(...args);
    } catch (error) {
      errorToast(error);
    } finally {
      button.disabled = false;
    }
  };
}
/** 从接口错误响应里取可读文案，兼容 {error:{code,message}} 与客户端 SDK 的异常。 */
export function apiError(body, fallback = '操作未完成，请稍后重试') {
  if (body && body.error && typeof body.error === 'object' && body.error.message) return body.error.message;
  if (body && typeof body.message === 'string' && body.message) return body.message;
  return fallback;
}
