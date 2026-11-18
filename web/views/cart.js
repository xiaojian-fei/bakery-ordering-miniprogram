import { el, clear, money, pageHead, empty, errorToast, toast, requestId, busy } from '../ui.js';

export async function render(ctx, mount, param, route) {
  if (route === 'checkout') return checkout(ctx, mount);
  return cart(ctx, mount);
}

async function cart(ctx, mount) {
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  let data;
  try {
    data = await ctx.api.cart.get();
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '购物车加载失败')));
    return;
  }
  await ctx.refreshCartCount();

  clear(mount);
  mount.appendChild(pageHead('购物车', data.items.length ? `共 ${data.items.length} 种商品` : '还没有挑选商品'));

  if (data.items.length === 0) {
    mount.appendChild(el('div', { class: 'card' }, empty('购物车是空的。'), el('a', { href: '#/' }, '去挑选商品 →')));
    return;
  }

  const card = el('div', { class: 'card' });
  let version = data.version;

  for (const item of data.items) {
    const value = el('span', { class: 'value' }, item.quantity);
    const dec = el('button', { class: 'small' }, '－');
    const inc = el('button', { class: 'small' }, '＋');
    const remove = el('button', { class: 'ghost small' }, '移除');

    const apply = async quantity => {
      try {
        const result = await ctx.api.cart.setLine({
          productId: item.productId, quantity, expectedVersion: version, requestId: requestId()
        });
        version = result.version;
        await cart(ctx, mount);
      } catch (error) {
        errorToast(error);
        await cart(ctx, mount);
      }
    };

    dec.addEventListener('click', () => apply(item.quantity - 1));
    more(inc, () => apply(item.quantity + 1));
    remove.addEventListener('click', () => apply(0));

    card.appendChild(el('div', { class: 'line-item' },
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, item.name),
        el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
          money(item.unitPriceCents) + ' × ' + item.quantity + '　可售 ' + item.available),
        item.issue ? el('div', { style: 'color:#a8443a;font-size:13px' }, issueText(item.issue)) : null),
      el('div', { class: 'qty' }, dec, value, inc),
      el('div', { style: 'min-width:80px;text-align:right;font-weight:600' }, money(item.lineTotalCents)),
      remove));
  }

  const clearButton = el('button', { class: 'ghost small' }, '清空购物车');
  clearButton.addEventListener('click', async () => {
    clearButton.disabled = true;
    try {
      const result = await ctx.api.cart.clear({ expectedVersion: version, requestId: requestId() });
      version = result.version;
      toast('购物车已清空', 'ok');
      await cart(ctx, mount);
    } catch (error) {
      errorToast(error);
    } finally {
      clearButton.disabled = false;
    }
  });

  mount.appendChild(card);
  mount.appendChild(el('div', { class: 'card' },
    el('div', { class: 'summary' },
      el('div', {}, el('span', {}, '商品合计（不含运费）'), el('span', {}, money(data.estimatedSubtotalCents)))),
    el('div', { class: 'actions', style: 'margin-top:16px;justify-content:space-between' },
      clearButton,
      data.canCheckout
        ? el('button', { class: 'primary', onclick: () => ctx.navigate('#/checkout') }, '去结算')
        : el('button', { class: 'primary', disabled: true, title: '请先处理库存或下架问题' }, '暂时无法结算'))));

  function more(button, handler) {
    let timer = null;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      clearTimeout(timer);
      Promise.resolve(handler()).finally(() => { timer = setTimeout(() => { button.disabled = false; }, 120); });
    });
  }
}

const issueText = code => ({
  PRODUCT_NOT_FOUND: '商品已不存在，请移除',
  PRODUCT_UNAVAILABLE: '商品已下架，请移除',
  OUT_OF_STOCK: '库存不足，请调整数量'
})[code] || '该项暂时无法结算';

async function checkout(ctx, mount) {
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  let cartData;
  let addresses = [];
  try {
    [cartData] = await Promise.all([ctx.api.cart.get()]);
    const page = await ctx.api.addresses.list({ limit: 50 });
    addresses = page.items;
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '加载失败')));
    return;
  }
  if (cartData.items.length === 0) {
    clear(mount).appendChild(el('div', { class: 'card' }, empty('购物车为空，无法结算。'), el('a', { href: '#/' }, '去挑选商品 →')));
    return;
  }

  let deliveryType = addresses.length > 0 ? 'delivery' : 'pickup';
  let addressId = (addresses.find(item => item.isDefault) || addresses[0])?._id || '';
  const items = cartData.items.map(item => ({ productId: item.productId, quantity: item.quantity }));

  const summaryBox = el('div', { class: 'summary' });
  const addressBox = el('div', {});
  const submit = el('button', { class: 'primary' }, '提交订单');
  const remark = el('textarea', { placeholder: '备注（选填，最多 200 字）' });

  const quote = async () => {
    clear(summaryBox).appendChild(el('div', {}, el('span', {}, '计算中…'), el('span', {}, '')));
    try {
      const data = await ctx.api.orders.quote({
        items,
        deliveryType,
        ...(deliveryType === 'delivery' ? { addressId } : {})
      });
      clear(summaryBox);
      for (const line of data.items) {
        summaryBox.appendChild(el('div', {},
          el('span', {}, line.name + ' × ' + line.quantity), el('span', {}, money(line.lineTotalCents))));
      }
      summaryBox.appendChild(el('div', {}, el('span', {}, '运费'),
        el('span', {}, data.shippingCents > 0 ? money(data.shippingCents) : '包邮')));
      summaryBox.appendChild(el('div', { class: 'total' },
        el('span', {}, '应付总额'), el('span', {}, money(data.totalCents))));
      submit.disabled = false;
    } catch (error) {
      clear(summaryBox).appendChild(el('div', {}, el('span', {}, error.message || '报价失败'), el('span', {}, '')));
      submit.disabled = true;
    }
  };

  const drawAddress = () => {
    clear(addressBox);
    if (deliveryType !== 'delivery') {
      addressBox.appendChild(el('p', { class: 'desc', style: 'color:#8a7a68;font-size:13px;margin:0' },
        '自取订单无需地址，到店后凭核销码提货。'));
      return;
    }
    if (addresses.length === 0) {
      addressBox.appendChild(el('p', { style: 'color:#a8443a;margin:0' },
        '还没有收货地址，请先 ', el('a', { href: '#/addresses' }, '添加地址'), '。'));
      return;
    }
    const select = el('select', {
      onchange: event => { addressId = event.target.value; quote(); }
    }, ...addresses.map(item => el('option', { value: item._id, selected: item._id === addressId },
      `${item.name}　${item.phone}　${item.province}${item.city}${item.district}${item.detail}`)));
    addressBox.appendChild(select);
  };

  const radio = value => el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-right:18px' },
    el('input', {
      type: 'radio', name: 'delivery', value, checked: deliveryType === value,
      onchange: () => {
        deliveryType = value;
        if (deliveryType === 'delivery' && !addressId) addressId = addresses[0]?._id || '';
        drawAddress();
        quote();
      }
    }), value === 'delivery' ? '配送' : '到店自取');

  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    if (deliveryType === 'delivery' && !addressId) { toast('请选择收货地址', 'error'); return; }
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      // 一次人工确认的结算意图：同一 requestId 重试不会重复下单。
      const attempt = await ctx.api.prepareCheckout({
        requestId: requestId(), items, deliveryType,
        ...(deliveryType === 'delivery' ? { addressId } : {}),
        ...(remark.value.trim() ? { remark: remark.value.trim() } : {})
      });
      const order = await attempt.submit();
      await ctx.api.cart.clear({ expectedVersion: cartData.version, requestId: requestId() });
      await ctx.refreshCartCount();
      toast('下单成功，请在 15 分钟内完成支付', 'ok');
      ctx.navigate('#/order/' + order._id);
    } catch (error) {
      errorToast(error);
      submit.disabled = false;
      submit.textContent = '提交订单';
    }
  });

  clear(mount);
  mount.appendChild(el('p', { style: 'margin:0 0 14px' }, el('a', { href: '#/cart' }, '← 返回购物车')));
  mount.appendChild(pageHead('确认订单', '配送按省份计算运费，满额包邮。'));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '履约方式'),
    el('div', {}, radio('delivery'), radio('pickup')),
    el('div', { style: 'margin-top:14px' }, addressBox)));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '订单备注'),
    el('label', { class: 'field' }, el('span', {}, '给店里的说明'), remark)));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '费用明细'),
    summaryBox,
    el('div', { class: 'actions', style: 'margin-top:16px' }, submit)));

  drawAddress();
  await quote();
}