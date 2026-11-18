import {
  el, clear, money, formatTime, statusBadge, STATUS_TEXT, DELIVERY_TEXT,
  pageHead, empty, errorToast, toast, requestId, field
} from '../ui.js';

const FILTERS = [
  { value: '', label: '全部' },
  { value: 'PENDING_PAYMENT', label: '待支付' },
  { value: 'PENDING_ACCEPTANCE', label: '待接单' },
  { value: 'ACCEPTED', label: '已接单' },
  { value: 'SHIPPING', label: '配送中' },
  { value: 'READY_FOR_PICKUP', label: '待自取' },
  { value: 'COMPLETED', label: '已完成' }
];

export async function render(ctx, mount, param, route) {
  if (route === 'order') return detail(ctx, mount, param);
  return list(ctx, mount);
}

async function list(ctx, mount) {
  let status = '';
  let cursor = null;
  let items = [];

  clear(mount);
  const head = pageHead('我的订单', '下单后 15 分钟内完成支付，超时自动关闭。');
  const chips = el('div', { class: 'actions', style: 'margin-bottom:16px' });
  const box = el('div', {});
  mount.appendChild(head);
  mount.appendChild(chips);
  mount.appendChild(box);

  function drawChips() {
    clear(chips);
    for (const filter of FILTERS) {
      chips.appendChild(el('button', {
        class: 'small' + (status === filter.value ? ' primary' : ''),
        onclick: () => { status = filter.value; items = []; cursor = null; load(true); }
      }, filter.label));
    }
  }

  async function load(reset = false) {
    if (reset) { items = []; cursor = null; clear(box).appendChild(el('p', { class: 'loading' }, '加载中…')); }
    let page;
    try {
      page = await ctx.api.orders.list({ ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: 10 });
    } catch (error) {
      clear(box).appendChild(el('div', { class: 'card' },
        el('p', {}, error.message || '订单加载失败'),
        el('button', { onclick: () => load(true) }, '重试')));
      return;
    }
    items = items.concat(page.items);
    cursor = page.nextCursor;
    draw();
  }

  function draw() {
    clear(box);
    if (items.length === 0) {
      box.appendChild(el('div', { class: 'card' }, empty('还没有订单。'), el('a', { href: '#/' }, '去挑选商品 →')));
      return;
    }
    for (const order of items) {
      box.appendChild(el('div', { class: 'card' },
        el('div', { class: 'actions', style: 'justify-content:space-between' },
          el('div', {},
            el('div', { class: 'name' }, order.items.map(item => item.name + ' × ' + item.quantity).join('、')),
            el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
              formatTime(order.createdAt), '　', DELIVERY_TEXT[order.deliveryType] || '')),
          el('div', { class: 'actions' },
            statusBadge(order.status),
            el('span', { style: 'font-weight:700' }, money(order.amounts.totalCents)),
            el('a', { class: 'button small', href: '#/order/' + order._id }, '详情')))));
    }
    if (cursor) {
      const more = el('button', {}, '加载更多');
      more.addEventListener('click', async () => { more.disabled = true; await load(); });
      box.appendChild(el('div', { class: 'actions', style: 'justify-content:center' }, more));
    }
  }

  drawChips();
  await load(true);
}

async function detail(ctx, mount, orderId) {
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  let order;
  let afterSale = null;
  let pickupCode = null;
  try {
    order = await ctx.api.orders.get(orderId);
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' },
      el('h2', {}, '无法打开订单'), el('p', {}, error.message || '请返回列表重试'),
      el('a', { href: '#/orders' }, '返回订单列表')));
    return;
  }
  try {
    const page = await ctx.api.afterSales.list({ limit: 50 });
    afterSale = page.items.find(item => item.orderId === orderId) || null;
  } catch (_) { /* 售后列表不可读时不影响订单查看 */ }
  if (order.deliveryType === 'pickup') {
    try { pickupCode = (await ctx.api.orders.pickupCode(orderId))?.code || null; } catch (_) { /* 尚未生成或已核销 */ }
  }

  const reload = () => detail(ctx, mount, orderId);
  clear(mount);
  mount.appendChild(el('p', { style: 'margin:0 0 14px' }, el('a', { href: '#/orders' }, '← 返回订单列表')));
  mount.appendChild(pageHead('订单详情',
    '订单号 ' + order._id, statusBadge(order.status)));

  const actionBar = el('div', { class: 'actions', style: 'margin-bottom:14px' });
  if (order.status === 'PENDING_PAYMENT') {
    const pay = el('button', { class: 'primary' }, '模拟支付');
    pay.addEventListener('click', async () => {
      pay.disabled = true;
      try {
        await ctx.api.orders.pay(order._id, { outcome: 'success', expectedVersion: order.version });
        toast('支付成功（模拟）', 'ok');
        await reload();
      } catch (error) { errorToast(error); pay.disabled = false; }
    });
    const cancel = el('button', { class: 'danger' }, '取消订单');
    cancel.addEventListener('click', async () => {
      if (!window.confirm('取消后库存会释放，确定取消？')) return;
      cancel.disabled = true;
      try {
        await ctx.api.orders.cancel(order._id, { expectedVersion: order.version });
        toast('订单已取消', 'ok');
        await reload();
      } catch (error) { errorToast(error); cancel.disabled = false; }
    });
    actionBar.appendChild(pay);
    actionBar.appendChild(cancel);
    actionBar.appendChild(el('span', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
      '支付截止：' + formatTime(order.expiresAt)));
  }
  const eligible = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY_FOR_PICKUP', 'SHIPPING', 'COMPLETED'];
  if (order.paymentStatus === 'PAID' && eligible.includes(order.status) && (!afterSale || afterSale.status === 'REJECTED')) {
    actionBar.appendChild(el('button', {
      onclick: () => { afterSaleForm(order); }
    }, '申请售后'));
  }
  if (actionBar.childNodes.length > 0) mount.appendChild(actionBar);

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '商品'),
    ...order.items.map(item => el('div', { class: 'line-item' },
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, item.name),
        el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
          money(item.unitPriceCents) + ' × ' + item.quantity)),
      el('div', { style: 'font-weight:600' }, money(item.lineTotalCents)))),
    el('div', { class: 'summary' },
      el('div', {}, el('span', {}, '商品合计'), el('span', {}, money(order.amounts.subtotalCents))),
      el('div', {}, el('span', {}, '运费'),
        el('span', {}, order.amounts.shippingCents > 0 ? money(order.amounts.shippingCents) : '包邮')),
      el('div', { class: 'total' }, el('span', {}, '实付'), el('span', {}, money(order.amounts.totalCents))))));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '履约信息'),
    el('div', { class: 'grid two' },
      el('div', {},
        el('p', {}, '方式：', DELIVERY_TEXT[order.deliveryType] || order.deliveryType),
        el('p', {}, '下单：', formatTime(order.createdAt)),
        order.remark ? el('p', {}, '备注：', order.remark) : null,
        pickupCode ? el('p', {}, '自取核销码：', el('strong', { style: 'letter-spacing:2px' }, pickupCode)) : null),
      el('div', {},
        order.addressSnapshot
          ? el('div', {},
            el('p', {}, '收货人：', order.addressSnapshot.name, '　', order.addressSnapshot.phone),
            el('p', {}, '地址：', order.addressSnapshot.province, order.addressSnapshot.city,
              order.addressSnapshot.district, order.addressSnapshot.detail))
          : el('p', { class: 'desc' }, '到店自取，无需配送地址')))));

  if (afterSale) {
    mount.appendChild(el('div', { class: 'card' },
      el('h2', {}, '售后'),
      el('p', {}, '状态：', el('span', { class: 'tag' }, afterSaleStatusText(afterSale.status))),
      el('p', {}, '原因：', afterSale.reason),
      afterSale.reviewReason ? el('p', {}, '审核说明：', afterSale.reviewReason) : null));
  }

  mount.appendChild(el('div', { class: 'card' }, el('h2', {}, '订单进度'), timeline(ctx, orderId)));

  function afterSaleForm(currentOrder) {
    const reason = el('textarea', { placeholder: '说明退款或售后原因（必填）' });
    const submit = el('button', { class: 'primary' }, '提交售后申请');
    submit.addEventListener('click', async () => {
      const text = reason.value.trim();
      if (!text) { toast('请填写售后原因', 'error'); return; }
      submit.disabled = true;
      try {
        await ctx.api.afterSales.apply({ orderId: currentOrder._id, requestId: requestId(), reason: text });
        toast('售后申请已提交，等待店主审核', 'ok');
        await reload();
      } catch (error) { errorToast(error); submit.disabled = false; }
    });
    const card = el('div', { class: 'card' },
      el('h2', {}, '申请售后'),
      el('label', { class: 'field' }, el('span', {}, '原因'), reason),
      el('div', { class: 'actions', style: 'margin-top:14px' }, submit));
    mount.insertBefore(card, actionBar.nextSibling);
    reason.focus();
  }
}

const afterSaleStatusText = status => ({
  REQUESTED: '待审核', APPROVED: '已通过，待退款', REJECTED: '已驳回', REFUNDED: '已退款'
})[status] || status;

function timeline(ctx, orderId) {
  const box = el('div', {}, el('p', { class: 'desc' }, '加载中…'));
  (async () => {
    try {
      const page = await ctx.api.orders.timeline({ orderId, limit: 20 });
      clear(box);
      if (page.items.length === 0) { box.appendChild(el('p', { class: 'desc' }, '暂无记录')); return; }
      for (const event of page.items) {
        box.appendChild(el('div', { class: 'line-item' },
          el('div', { class: 'grow' },
            el('div', {}, actionText(event.action),
              event.fromStatus && event.toStatus
                ? el('span', { class: 'desc', style: 'color:#8a7a68' },
                  `　${STATUS_TEXT[event.fromStatus] || event.fromStatus} → ${STATUS_TEXT[event.toStatus] || event.toStatus}`)
                : null),
            el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
              formatTime(event.createdAt), event.actorOpenid ? '　' + event.actorOpenid : ''))));
      }
    } catch (error) {
      clear(box).appendChild(el('p', { class: 'desc' }, error.message || '进度加载失败'));
    }
  })();
  return box;
}

const actionText = action => ({
  create: '提交订单', reserve: '预留库存', pay: '支付成功（模拟）', cancel: '取消订单',
  expire: '超时关闭', accept: '商家接单', ship: '商家发货', readyForPickup: '备货完成，待自取',
  complete: '订单完成', reject: '商家驳回'
})[action] || action;