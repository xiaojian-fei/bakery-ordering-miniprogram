import {
  el, clear, money, formatTime, statusBadge, pageHead, empty,
  errorToast, toast, requestId, field, askConfirm, apiError
} from '../ui.js';

const TABS = [
  ['products', '商品与库存'],
  ['shop', '店铺与运费'],
  ['after-sales', '售后审核'],
  ['statistics', '经营统计'],
  ['staff', '员工账号']
];

export async function render(ctx, mount, param) {
  const tab = TABS.some(([value]) => value === param) ? param : 'products';
  clear(mount);
  mount.appendChild(pageHead('店铺管理', '店主可以维护商品库存、店铺配置、售后与员工账号。'));

  const nav = el('div', { class: 'actions', style: 'margin-bottom:18px' });
  for (const [value, label] of TABS) {
    nav.appendChild(el('button', {
      class: 'small' + (value === tab ? ' primary' : ''),
      onclick: () => ctx.navigate('#/owner/' + value)
    }, label));
  }
  mount.appendChild(nav);

  const body = el('div', {});
  mount.appendChild(body);

  const loaders = { products, shop, 'after-sales': afterSales, statistics, staff };
  await loaders[tab](ctx, body);
}

/* ---------------- 商品与库存 ---------------- */

async function products(ctx, mount) {
  mount.appendChild(el('p', { class: 'loading' }, '加载中…'));
  let items;
  try {
    items = (await ctx.api.catalog.list({ includeUnavailable: true, limit: 50 })).items;
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '加载失败')));
    return;
  }

  const reload = () => products(ctx, mount);
  clear(mount);
  mount.appendChild(el('div', { class: 'actions', style: 'margin-bottom:14px' },
    el('button', { class: 'primary', onclick: () => edit(null) }, '新增商品')));

  const table = el('div', { class: 'card' });
  const row = product => el('tr', {},
    el('td', {},
      product.image
        ? el('img', {
          src: product.image, alt: '',
          style: 'width:38px;height:38px;object-fit:cover;border-radius:8px;vertical-align:middle;margin-right:8px'
        })
        : null,
      product.name),
    el('td', {}, product.category || '—'),
    el('td', { class: 'num' }, money(product.priceCents)),
    el('td', { class: 'num' }, product.onHand + ' / ' + product.reserved),
    el('td', {}, product.isOnSale ? el('span', { class: 'status active' }, '在售')
      : el('span', { class: 'status dead' }, '下架')),
    el('td', {}, el('div', { class: 'actions' },
      el('button', { class: 'small', onclick: () => edit(product) }, '编辑'),
      el('button', { class: 'small', onclick: () => adjust(product) }, '调整库存'))));
  const rows = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '商品'), el('th', {}, '分类'), el('th', { class: 'num' }, '价格'),
      el('th', { class: 'num' }, '在库/预留'), el('th', {}, '状态'), el('th', {}, '操作'))),
    el('tbody', {}, ...items.map(row)));
  table.appendChild(rows);
  mount.appendChild(table);

  function edit(product) {
    const isNew = !product;
    const name = el('input', { value: product?.name || '' });
    const price = el('input', { type: 'number', min: '0.01', step: '0.01', value: product ? (product.priceCents / 100).toFixed(2) : '' });
    const category = el('input', { value: product?.category || '' });
    const desc = el('textarea', {}, product?.desc || '');
    const onSale = el('input', { type: 'checkbox', checked: isNew ? true : product.isOnSale });
    const featured = el('input', { type: 'checkbox', checked: product?.isFeatured === true });
    const imageValue = el('input', { value: product?.image || '', placeholder: '留空或上传图片' });
    const preview = el('div', { style: 'margin-top:8px' },
      product?.image ? el('img', { src: product.image, alt: '', style: 'width:96px;height:96px;object-fit:cover;border-radius:10px' }) : null);
    const picker = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('图片不能超过 2MB', 'error'); return; }
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      try {
        const response = await fetch('/api/upload', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: file.type, data: base64 })
        });
        const body = await response.json();
        if (!response.ok) throw new Error(apiError(body, '上传失败'));
        imageValue.value = body.url;
        clear(preview).appendChild(el('img', {
          src: body.url, alt: '', style: 'width:96px;height:96px;object-fit:cover;border-radius:10px'
        }));
        toast('图片已上传', 'ok');
      } catch (error) { errorToast(error); }
    });

    const save = el('button', { class: 'primary' }, '保存商品');
    save.addEventListener('click', async () => {
      const priceCents = Math.round(Number(price.value) * 100);
      if (!name.value.trim() || !Number.isSafeInteger(priceCents) || priceCents < 1) {
        toast('请填写商品名称与有效价格', 'error');
        return;
      }
      save.disabled = true;
      try {
        await ctx.api.catalog.save({
          productId: isNew ? 'p-' + requestId().replace(/-/g, '').slice(0, 20) : product._id,
          expectedVersion: isNew ? 0 : product.catalogVersion,
          requestId: requestId(),
          name: name.value.trim(), priceCents, desc: desc.value.trim(),
          category: category.value.trim(), image: imageValue.value.trim(),
          isOnSale: onSale.checked, isFeatured: featured.checked
        });
        toast('商品已保存', 'ok');
        await reload();
      } catch (error) {
        errorToast(error);
        save.disabled = false;
      }
    });

    clear(mount);
    mount.appendChild(el('div', { class: 'card' },
      el('h2', {}, isNew ? '新增商品' : '编辑商品'),
      el('div', { class: 'form-grid' },
        field('商品名称', name), field('价格（元）', price), field('分类', category)),
      el('label', { class: 'field', style: 'margin-top:12px' }, el('span', {}, '描述'), desc),
      el('label', { class: 'field', style: 'margin-top:12px' }, el('span', {}, '图片地址'), imageValue),
      el('div', { style: 'margin-top:10px' }, picker, preview),
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:14px' }, onSale, el('span', {}, '上架销售')),
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:8px' }, featured, el('span', {}, '设为招牌')),
      el('div', { class: 'actions', style: 'margin-top:18px' },
        save, el('button', { onclick: () => reload() }, '取消'))));
  }

  function adjust(product) {
    const onHand = el('input', { type: 'number', min: '0', step: '1', value: product.onHand });
    const reason = el('input', { placeholder: '如 到货补货 / 盘点修正' });
    const submit = el('button', { class: 'primary' }, '提交调整');
    submit.addEventListener('click', async () => {
      const value = Number(onHand.value);
      if (!Number.isInteger(value) || value < 0) { toast('在库数量需为非负整数', 'error'); return; }
      if (!reason.value.trim()) { toast('请填写调整原因', 'error'); return; }
      submit.disabled = true;
      try {
        await ctx.api.inventory.adjust({
          requestId: requestId(), productId: product._id, onHand: value,
          expectedVersion: product.inventoryVersion, reason: reason.value.trim()
        });
        toast('库存已调整', 'ok');
        await reload();
      } catch (error) {
        errorToast(error);
        submit.disabled = false;
      }
    });
    clear(mount);
    mount.appendChild(el('div', { class: 'card' },
      el('h2', {}, '调整库存：' + product.name),
      el('p', { class: 'desc', style: 'color:#8a7a68' },
        '当前在库 ' + product.onHand + '，已预留 ' + product.reserved + '。在库数量不能低于已预留。'),
      el('div', { class: 'form-grid' },
        field('目标在库数量', onHand), field('调整原因', reason)),
      el('div', { class: 'actions', style: 'margin-top:16px' },
        submit, el('button', { onclick: () => reload() }, '取消'))));
  }
}

/* ---------------- 店铺与运费 ---------------- */

async function shop(ctx, mount) {
  mount.appendChild(el('p', { class: 'loading' }, '加载中…'));
  let shopInfo;
  try {
    shopInfo = await ctx.api.shop.get();
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '加载失败')));
    return;
  }
  const name = el('input', { value: shopInfo.name || '' });
  const phone = el('input', { value: shopInfo.phone || '' });
  const wechat = el('input', { value: shopInfo.wechat || '' });
  const address = el('input', { value: shopInfo.address || '' });
  const deliveryNote = el('textarea', {}, shopInfo.deliveryNote || '');
  const provinces = el('input', { value: (shopInfo.shipping.northernProvinces || []).join('、') });
  const fields = {};
  for (const [key, label, value] of [
    ['northernThresholdCents', '北方包邮门槛（元）', shopInfo.shipping.northernThresholdCents],
    ['otherThresholdCents', '其他地区包邮门槛（元）', shopInfo.shipping.otherThresholdCents],
    ['northernFeeCents', '北方配送费（元）', shopInfo.shipping.northernFeeCents],
    ['otherFeeCents', '其他地区配送费（元）', shopInfo.shipping.otherFeeCents]
  ]) {
    fields[key] = el('input', { type: 'number', min: '0', step: '0.01', value: (value / 100).toFixed(2) });
  }

  const save = el('button', { class: 'primary' }, '保存配置');
  save.addEventListener('click', async () => {
    const shipping = { northernProvinces: provinces.value.split(/[、,，\s]+/).map(v => v.trim()).filter(Boolean) };
    for (const [key, input] of Object.entries(fields)) {
      const cents = Math.round(Number(input.value) * 100);
      if (!Number.isSafeInteger(cents) || cents < 0) { toast('运费配置需为非负数', 'error'); return; }
      shipping[key] = cents;
    }
    if (shipping.northernProvinces.length === 0) { toast('请至少填写一个北方省份', 'error'); return; }
    save.disabled = true;
    try {
      await ctx.api.shop.save({
        requestId: requestId(), expectedVersion: shopInfo.version,
        name: name.value.trim(), phone: phone.value.trim(), wechat: wechat.value.trim(),
        address: address.value.trim(), deliveryNote: deliveryNote.value.trim(),
        banners: shopInfo.banners || [], shipping
      });
      toast('店铺配置已保存', 'ok');
      await shop(ctx, mount);
    } catch (error) {
      errorToast(error);
      save.disabled = false;
    }
  });

  clear(mount);
  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '店铺信息'),
    el('div', { class: 'form-grid' },
      field('店铺名称', name), field('电话', phone), field('联系账号', wechat), field('店铺地址', address)),
    el('label', { class: 'field', style: 'margin-top:12px' }, el('span', {}, '配送说明'), deliveryNote)));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '运费规则'),
    el('div', { class: 'form-grid' },
      field('北方省份（用、分隔）', provinces),
      field('北方包邮门槛（元）', fields.northernThresholdCents),
      field('其他地区包邮门槛（元）', fields.otherThresholdCents),
      field('北方配送费（元）', fields.northernFeeCents),
      field('其他地区配送费（元）', fields.otherFeeCents)),
    el('div', { class: 'actions', style: 'margin-top:16px' }, save)));
}

/* ---------------- 售后审核 ---------------- */

const AFTER_SALE_TEXT = { REQUESTED: '待审核', APPROVED: '已通过待退款', REJECTED: '已驳回', REFUNDED: '已退款' };

async function afterSales(ctx, mount) {
  mount.appendChild(el('p', { class: 'loading' }, '加载中…'));
  let list;
  let orders;
  try {
    list = (await ctx.api.afterSales.list({ manage: true, limit: 50 })).items;
    orders = (await ctx.api.orders.list({ manage: true, limit: 50 })).items;
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '加载失败')));
    return;
  }
  const orderById = new Map(orders.map(order => [order._id, order]));
  clear(mount);
  if (list.length === 0) {
    mount.appendChild(el('div', { class: 'card' }, empty('暂无售后申请。')));
    return;
  }

  for (const record of list) {
    const order = orderById.get(record.orderId);
    const actions = el('div', { class: 'actions', style: 'margin-top:12px' });

    if (record.status === 'REQUESTED') {
      const note = el('input', { placeholder: '审核说明（必填）', style: 'max-width:280px' });
      const approve = el('button', { class: 'primary' }, '通过');
      const reject = el('button', { class: 'danger' }, '驳回');
      const review = decision => async () => {
        if (!note.value.trim()) { toast('请填写审核说明', 'error'); return; }
        approve.disabled = true; reject.disabled = true;
        try {
          const recovery = ctx.recovery().ownerAfterSale;
          await recovery.prepare({ type: 'review', payload: {
            afterSaleId: record._id, expectedVersion: record.version,
            requestId: requestId(), decision, reason: note.value.trim()
          } });
          await recovery.submit();
          toast('审核已提交', 'ok');
          await afterSales(ctx, mount);
        } catch (error) {
          errorToast(error);
          approve.disabled = false; reject.disabled = false;
        }
      };
      approve.addEventListener('click', review('approve'));
      reject.addEventListener('click', review('reject'));
      actions.appendChild(note);
      actions.appendChild(approve);
      actions.appendChild(reject);
    }

    if (record.status === 'APPROVED') {
      const refund = el('button', { class: 'primary' }, '执行退款');
      refund.addEventListener('click', async () => {
        if (!order) { toast('请刷新后重试（订单不在当前列表）', 'error'); return; }
        const ok = await askConfirm('确认对订单 ' + order._id + ' 执行整单退款？金额 ' + money(order.amounts.totalCents) + '。',
          { confirmText: '确认退款' });
        if (!ok) return;
        refund.disabled = true;
        try {
          // 退款保持带乐观锁的直连调用：服务端按 afterSaleId 幂等，重复点击不会重复退款。
          await ctx.api.refunds.executeApproved({ afterSaleId: record._id, expectedOrderVersion: order.version });
          toast('退款已完成（模拟）', 'ok');
          await afterSales(ctx, mount);
        } catch (error) {
          errorToast(error);
          refund.disabled = false;
        }
      });
      actions.appendChild(refund);
    }

    mount.appendChild(el('div', { class: 'card' },
      el('div', { class: 'actions', style: 'justify-content:space-between' },
        el('div', {},
          el('div', { class: 'name' }, order ? order.items.map(item => item.name + ' × ' + item.quantity).join('、') : record.orderId),
          el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' },
            '申请时间 ' + formatTime(record.createdAt), '　订单金额 ',
            order ? money(order.amounts.totalCents) : '—'),
          el('div', { style: 'margin-top:6px' }, '原因：', record.reason),
          record.reviewReason ? el('div', { class: 'desc' }, '审核说明：', record.reviewReason) : null),
        el('div', {},
          el('span', { class: 'tag' }, AFTER_SALE_TEXT[record.status] || record.status),
          order ? el('div', { style: 'margin-top:6px' }, statusBadge(order.status)) : null)),
      actions));
  }
}

/* ---------------- 经营统计 ---------------- */

async function statistics(ctx, mount) {
  const today = new Date();
  const iso = date => date.toISOString().slice(0, 10);
  const startInput = el('input', { type: 'date', value: iso(new Date(today.getTime() - 6 * 86400000)) });
  const endInput = el('input', { type: 'date', value: iso(today) });
  const box = el('div', {});
  const run = el('button', { class: 'primary' }, '查询');

  const query = async () => {
    const startAt = new Date(startInput.value + 'T00:00:00').getTime();
    const endAt = new Date(endInput.value + 'T00:00:00').getTime() + 86400000;
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      toast('请选择有效的日期范围', 'error');
      return;
    }
    clear(box).appendChild(el('p', { class: 'loading' }, '查询中…'));
    let data;
    try {
      data = await ctx.api.statistics.summary({ startAt, endAt });
    } catch (error) {
      clear(box).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '查询失败')));
      return;
    }
    clear(box);
    const metric = (label, value) => el('div', { class: 'card', style: 'margin:0' },
      el('div', { class: 'desc', style: 'color:#8a7a68;font-size:13px' }, label),
      el('div', { style: 'font-size:22px;font-weight:700;margin-top:6px' }, value));
    box.appendChild(el('div', { class: 'grid metrics', style: 'margin-bottom:14px' },
      metric('收款（模拟）', money(data.grossCents)),
      metric('退款', money(data.refundCents)),
      metric('净额', money(data.netCents)),
      metric('已支付订单', data.paidOrderCount),
      metric('已完成订单', data.completedOrderCount)));
    const table = el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, '商品'), el('th', { class: 'num' }, '销量'))),
      el('tbody', {}, ...(data.productSales.length ? data.productSales.map(row =>
        el('tr', {}, el('td', {}, row.name), el('td', { class: 'num' }, row.quantity)))
        : [el('tr', {}, el('td', { colspan: '2' }, '该时间段没有已完成订单'))])));
    box.appendChild(el('div', { class: 'card' }, el('h2', {}, '销量'), table,
      el('p', { class: 'desc', style: 'color:#8a7a68;font-size:12px;margin-top:10px' },
        '口径：' + data.salesBasis)));
  };

  run.addEventListener('click', query);
  clear(mount);
  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '统计区间'),
    el('div', { class: 'form-grid' }, field('开始日期', startInput), field('结束日期', endInput)),
    el('div', { class: 'actions', style: 'margin-top:14px' }, run)));
  mount.appendChild(box);
  await query();
}

/* ---------------- 员工账号 ---------------- */

async function staff(ctx, mount) {
  mount.appendChild(el('p', { class: 'loading' }, '加载中…'));
  let list;
  try {
    const response = await fetch('/api/staff', { credentials: 'same-origin' });
    const body = await response.json();
    if (!response.ok) throw new Error(apiError(body, '加载失败'));
    list = body.staff;
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '加载失败')));
    return;
  }

  clear(mount);
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '用户名'), el('th', {}, '角色'), el('th', {}, '状态'), el('th', {}, '操作'))),
    el('tbody', {}, ...list.map(person => el('tr', {},
      el('td', {}, person.username || '—'),
      el('td', {}, person.role === 'owner' ? '店主' : '店员'),
      el('td', {}, person.active ? el('span', { class: 'status active' }, '启用') : el('span', { class: 'status dead' }, '停用')),
      el('td', {}, person.role === 'owner' ? el('span', { class: 'desc' }, '不可修改')
        : el('button', {
          class: 'small',
          onclick: async event => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              const response = await fetch('/api/staff/access', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: person.username, enabled: !person.active })
              });
              const body = await response.json();
              if (!response.ok) throw new Error(apiError(body, '操作失败'));
              toast(person.active ? '已停用' : '已启用', 'ok');
              await staff(ctx, mount);
            } catch (error) { errorToast(error); button.disabled = false; }
          }
        }, person.active ? '停用' : '启用'))))));
  mount.appendChild(el('div', { class: 'card' }, el('h2', {}, '员工账号'), table));

  const username = el('input', { placeholder: '3～32 位字母数字' });
  const password = el('input', { type: 'password', placeholder: '至少 12 位字符' });
  const create = el('button', { class: 'primary' }, '创建员工账号');
  create.addEventListener('click', async () => {
    if (!username.value.trim() || !password.value) { toast('请填写用户名与口令', 'error'); return; }
    create.disabled = true;
    try {
      const response = await fetch('/api/staff', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.value.trim(), password: password.value })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiError(body, '创建失败'));
      toast('员工账号已创建', 'ok');
      await staff(ctx, mount);
    } catch (error) { errorToast(error); create.disabled = false; }
  });

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '新增员工'),
    el('p', { class: 'desc', style: 'color:#8a7a68' }, '员工口令至少 12 位；员工只能处理履约，不能修改店铺配置与退款。'),
    el('div', { class: 'form-grid' }, field('用户名', username), field('初始口令', password)),
    el('div', { class: 'actions', style: 'margin-top:14px' }, create)));
}