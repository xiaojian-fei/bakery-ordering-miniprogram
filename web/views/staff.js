import {
  el, clear, money, formatTime, statusBadge, DELIVERY_TEXT,
  pageHead, empty, errorToast, toast, requestId
} from '../ui.js';

const TABS = [
  { value: 'PENDING_ACCEPTANCE', label: '待接单' },
  { value: 'ACCEPTED', label: '已接单待履约' },
  { value: 'SHIPPING', label: '配送中' },
  { value: 'READY_FOR_PICKUP', label: '待自取' },
  { value: '', label: '全部订单' }
];

export async function render(ctx, mount) {
  let status = 'PENDING_ACCEPTANCE';
  let orders = [];

  const head = pageHead('履约工作台', '按订单状态推进：接单 → 发货或备货 → 完成。');
  const chips = el('div', { class: 'actions', style: 'margin-bottom:16px' });
  const box = el('div', {});
  clear(mount);
  mount.appendChild(head);
  mount.appendChild(chips);
  mount.appendChild(box);

  function drawChips() {
    clear(chips);
    for (const tab of TABS) {
      chips.appendChild(el('button', {
        class: 'small' + (status === tab.value ? ' primary' : ''),
        onclick: () => { status = tab.value; load(); }
      }, tab.label));
    }
  }

  async function load() {
    clear(box).appendChild(el('p', { class: 'loading' }, '加载中…'));
    let page;
    try {
      page = await ctx.api.orders.list({ manage: true, ...(status ? { status } : {}), limit: 30 });
    } catch (error) {
      clear(box).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '订单加载失败'),
        el('button', { onclick: load }, '重试')));
      return;
    }
    orders = page.items;
    draw();
    try {
      const pending = await ctx.recovery().fulfillment.inspect();
      if (pending) box.prepend(pendingBanner(pending));
    } catch (error) {
      if (error.code !== 'INVALID_FULFILLMENT_RECORD') toast(error.message || '本机草稿不可读', 'error');
    }
  }

  /**
   * 履约动作走恢复协议：先落草稿再发送，结果不明时可用同一 requestId 重试，
   * 不会因为网络中断而把同一动作做两遍。
   */
  async function act(action, order, extra = {}) {
    const recovery = ctx.recovery().fulfillment;
    await recovery.prepare({
      action, payload: { orderId: order._id, expectedVersion: order.version, requestId: requestId(), ...extra }
    });
    const { result } = await recovery.submit();
    toast('操作成功', 'ok');
    await load();
    return result;
  }

  /** 上次履约动作结果未确认时，在顶部给出找回入口。 */
  function pendingBanner(pending) {
    const box = el('div', { class: 'card', style: 'border-color:#e3c3bd;background:#fdf6f4' },
      el('h2', {}, '上次履约操作结果未确认'),
      el('p', { style: 'margin:0;color:#6b5a46' },
        '请求已发出但没有收到确认。点“重试找回”会用同一个请求重发，不会重复执行。'),
      el('div', { class: 'actions', style: 'margin-top:12px' }));
    const retry = el('button', { class: 'primary' }, '重试找回');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        const { result } = await ctx.recovery().fulfillment.submit();
        toast('已找回：订单当前为 ' + (result?.status || '已更新'), 'ok');
        await load();
      } catch (error) {
        errorToast(error);
        retry.disabled = false;
      }
    });
    const drop = el('button', { class: 'danger' }, '放弃并继续');
    drop.addEventListener('click', async () => {
      const question = '放弃后不再保留这次动作的记录；如果服务端已经执行，订单状态会体现在列表里。确定放弃？';
      if (!window.confirm(question)) return;
      drop.disabled = true;
      try {
        await ctx.recovery().fulfillment.discard({ acknowledgeUncertain: true });
        await load();
      } catch (error) {
        errorToast(error);
        drop.disabled = false;
      }
    });
    box.lastChild.appendChild(retry);
    box.lastChild.appendChild(drop);
    return box;
  }

  function draw() {
    clear(box);
    if (orders.length === 0) {
      box.appendChild(el('div', { class: 'card' }, empty('当前没有需要处理的订单。')));
      return;
    }
    for (const order of orders) {
      const actions = el('div', { class: 'actions', style: 'margin-top:12px' });
      const wrap = async (button, work) => {
        if (button.disabled) return;
        button.disabled = true;
        try { await work(); } catch (error) { errorToast(error); button.disabled = false; }
      };

      if (order.status === 'PENDING_ACCEPTANCE') {
        const accept = el('button', { class: 'primary' }, '接单');
        accept.addEventListener('click', () => wrap(accept, () => act('accept', order)));
        actions.appendChild(accept);
      }
      if (order.status === 'ACCEPTED' && order.deliveryType === 'delivery') {
        const carrier = el('input', { placeholder: '承运方，如 顺丰', style: 'max-width:180px' });
        const tracking = el('input', { placeholder: '运单号（4～80 位字母数字）', style: 'max-width:220px' });
        const ship = el('button', { class: 'primary' }, '确认发货');
        ship.addEventListener('click', () => wrap(ship, async () => {
          if (!carrier.value.trim() || !tracking.value.trim()) throw new Error('请填写承运方与运单号');
          await act('ship', order, { carrier: carrier.value.trim(), trackingNo: tracking.value.trim() });
        }));
        actions.appendChild(carrier);
        actions.appendChild(tracking);
        actions.appendChild(ship);
      }
      if (order.status === 'ACCEPTED' && order.deliveryType === 'pickup') {
        const ready = el('button', { class: 'primary' }, '备货完成，生成核销码');
        ready.addEventListener('click', () => wrap(ready, () => act('readyForPickup', order)));
        actions.appendChild(ready);
      }
      if (order.status === 'SHIPPING') {
        const complete = el('button', { class: 'primary' }, '标记完成');
        complete.addEventListener('click', () => wrap(complete, () => act('complete', order)));
        actions.appendChild(complete);
      }
      if (order.status === 'READY_FOR_PICKUP') {
        const code = el('input', { placeholder: '顾客核销码（12 位）', style: 'max-width:200px' });
        const complete = el('button', { class: 'primary' }, '核销并完成');
        complete.addEventListener('click', () => wrap(complete, async () => {
          const value = code.value.trim().toUpperCase();
          if (!/^[0-9A-F]{12}$/.test(value)) throw new Error('核销码需为 12 位十六进制字符');
          await act('complete', order, { pickupCode: value });
        }));
        actions.appendChild(code);
        actions.appendChild(complete);
      }

      box.appendChild(el('div', { class: 'card' },
        el('div', { class: 'actions', style: 'justify-content:space-between' },
          el('div', {},
            el('div', { class: 'name' }, order.items.map(item => item.name + ' × ' + item.quantity).join('、')),
            el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
              formatTime(order.createdAt), '　', DELIVERY_TEXT[order.deliveryType] || '',
              '　', money(order.amounts.totalCents)),
            order.addressSnapshot
              ? el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
                order.addressSnapshot.name, '　', order.addressSnapshot.phone, '　',
                order.addressSnapshot.province, order.addressSnapshot.city,
                order.addressSnapshot.district, order.addressSnapshot.detail)
              : el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' }, '到店自取'),
            order.remark ? el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' }, '备注：', order.remark) : null),
          statusBadge(order.status)),
        actions));
    }
  }

  drawChips();
  await load();
}