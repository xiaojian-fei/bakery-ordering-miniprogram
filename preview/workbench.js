'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = cents => '¥' + (cents / 100).toFixed(2);
  const statuses = { PENDING_PAYMENT: '待支付', PENDING_ACCEPTANCE: '待接单', ACCEPTED: '已接单', SHIPPING: '配送中', READY_FOR_PICKUP: '待自取', COMPLETED: '已完成', CANCELLED: '已取消', EXPIRED: '已超时', REQUESTED: '待审核', APPROVED: '已批准待退款', REJECTED: '已拒绝', REFUNDED: '已退款', PENDING: '待处理', PROCESSING: '处理中', DELIVERED: '已处理', FAILED: '处理失败' };
  const actionNames = { create: '订单创建', pay: '模拟支付成功', cancel: '顾客取消', expire: '支付超时', accept: '店员接单', ship: '登记发货', readyForPickup: '准备自取', complete: '履约完成', refund: '模拟退款', merchantReject: '店主拒单', paymentFailed: '模拟支付失败' };
  let serial = 0, identity = 'buyer', tab = 'catalog', client, recovery, state = {}, attempt = null, switching = false, busy = 0, renderEpoch = 0;
  const rid = prefix => prefix + '-' + Date.now() + '-' + (++serial);
  const button = (label, action, id = '', css = '') => `<button class="${css}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
  const field = (name, label, value = '', type = 'text') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;
  async function post(url, data) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error('本地操作未完成，请刷新后重试');
    return result;
  }
  function message(value, error = false) { const box = $('#message'); box.textContent = value; box.className = error ? 'error' : ''; box.style.display = 'block'; }
  function details(html) { $('#detail-content').innerHTML = html; $('#details').showModal(); }
  function ask(label, value = '') {
    details(`<h2>${esc(label)}</h2><form id="prompt-form" class="stack"><label>${esc(label)}<input name="value" value="${esc(value)}" maxlength="300" required></label><button class="primary">确认</button></form>`);
    return new Promise(resolve => { state.promptResolve = resolve; });
  }
  const managed = () => identity !== 'buyer';
  function updateBusy(delta = 0) {
    busy = Math.max(0, busy + delta);
    $('#identity').disabled = switching || busy > 0;
    $('#navigation').inert = switching || busy > 0;
    $('#content').inert = switching || busy > 0;
  }
  async function switchIdentity(next) {
    switching = true; renderEpoch += 1; updateBusy();
    client?.clearSession(); attempt = null;
    try {
      await post('/demo/identity', { identity: next }); identity = next;
      client = window.TradeClient.createTradeClient({ send: envelope => post('/api', envelope) });
      if (managed()) await client.staff.login('LOCAL_DEMO_ONLY');
      const info = await (await fetch('/demo/state')).json(), actor = await client.identity.me();
      recovery = window.CheckoutRecovery.createCheckoutRecovery({ client, subjectId: actor.openid,
        namespace: 'bakery.demo.' + info.instanceId, storage: {
          get: key => { const raw = localStorage.getItem(key); if (!raw) return null; try { return JSON.parse(raw); } catch (_) { return { schemaVersion: -1 }; } },
          set: (key, value) => localStorage.setItem(key, JSON.stringify(value)), remove: key => localStorage.removeItem(key)
        } });
      state = {}; tab = 'catalog'; await render();
    } finally { switching = false; updateBusy(); }
  }
  function navigation() {
    const tabs = [['catalog', '商品'], ['cart', '购物车'], ['addresses', '收货地址'], ['orders', managed() ? '履约工作台' : '我的订单'], ['afterSales', '售后'], ['notifications', '通知记录']];
    if (identity === 'owner') tabs.push(['statistics', '经营统计'], ['shop', '店铺设置']);
    $('#navigation').innerHTML = tabs.map(([key, label]) => `<button data-tab="${key}" class="${key === tab ? 'active' : ''}">${label}</button>`).join('');
  }
  async function render() {
    const ticket = ++renderEpoch, activeTab = tab, activeIdentity = identity, activeClient = client, activeRecovery = recovery, view = {};
    navigation();
    let html = '';
    if (tab === 'catalog') {
      view.products = (await activeClient.catalog.list({ includeUnavailable: identity === 'owner', limit: 50 })).items;
      html = '<div class="toolbar"><h2>商品</h2>' + (identity === 'owner' ? button('新增商品', 'new-product', '', 'primary') : '') + '</div><div class="cards">';
      html += view.products.map(p => `<article class="card"><span class="pill">${esc(p.category || '商品')}</span><h3 style="margin-top:14px">${esc(p.name)}</h3><p class="muted">${esc(p.desc || '暂无描述')}</p><div class="price">${money(p.priceCents)}</div><p class="muted">可售 ${p.available} 件 · ${p.isOnSale ? '上架中' : '已下架'}</p><div class="row">${button('加入购物车', 'add-cart', p._id, 'primary')}${identity === 'owner' ? button('编辑', 'edit-product', p._id) + button('盘点库存', 'stock', p._id) : ''}</div></article>`).join('') + '</div>';
    } else if (tab === 'cart') {
      view.cart = await activeClient.cart.get(); view.addresses = (await activeClient.addresses.list({ limit: 50 })).items;
      try { view.recoveryDraft = await activeRecovery.inspect(); } catch (error) { view.recoveryProblem = error.message; }
      html = '<h2>购物车</h2>' + (view.cart.items.map(item => `<section class="card"><h3>${esc(item.name)}</h3><div class="row"><span>${money(item.unitPriceCents || 0)} × ${item.quantity}</span>${button('−', 'cart-minus', item.productId)}${button('+', 'cart-plus', item.productId)}${button('移除', 'cart-remove', item.productId)}</div><p class="muted">${item.issue ? '当前不可结算：请检查上架状态或数量' : '可售 ' + item.available + ' 件'}</p></section>`).join('') || '<div class="card empty">购物车为空</div>');
      if (view.recoveryDraft || view.recoveryProblem) html += `<section class="card"><h3>上次结算</h3><p>${view.recoveryProblem ? esc(view.recoveryProblem) : '已保留原请求与报价 ' + money(view.recoveryDraft.totalCents)}</p><div class="row">${view.recoveryDraft ? button('恢复上次结算', 'restore-checkout', '', 'primary') : ''}${button('清理本地草稿', 'discard-checkout')}</div><p class="muted">清理草稿不会取消服务器上的订单。</p></section>`;
      if (view.cart.items.length) html += `<section class="card"><p>商品估算：<strong>${money(view.cart.estimatedSubtotalCents)}</strong></p><form id="quote-form" class="stack"><label>取货方式<select name="deliveryType"><option value="pickup">到店自取</option><option value="delivery">配送</option></select></label><label>配送地址<select name="addressId"><option value="">请选择地址</option>${view.addresses.map(a => `<option value="${esc(a._id)}" ${a.isDefault ? 'selected' : ''}>${esc(a.name + ' · ' + a.province + a.detail)}</option>`).join('')}</select></label><label>备注<input name="remark" maxlength="200"></label><button class="primary">核对金额</button></form></section>`;
      html += '<section id="quote-result"></section>';
    } else if (tab === 'addresses') {
      view.addresses = (await activeClient.addresses.list({ limit: 50 })).items;
      html = '<div class="toolbar"><h2>收货地址</h2>' + button('新增地址', 'new-address', '', 'primary') + '</div>';
      html += view.addresses.map(a => `<section class="card"><h3>${esc(a.name)} ${a.isDefault ? '<span class="pill">默认地址</span>' : ''}</h3><p>${esc(a.phone)}<br>${esc(a.province + a.city + a.district + a.detail)}</p><div class="row">${button('编辑', 'edit-address', a._id)}${button('删除', 'remove-address', a._id, 'danger')}</div></section>`).join('') || '<div class="card empty">暂无地址</div>';
    } else if (tab === 'orders') {
      view.orders = (await activeClient.orders.list({ manage: managed(), limit: 50 })).items;
      html = '<h2>' + (managed() ? '履约工作台' : '我的订单') + '</h2>';
      html += view.orders.map(order => {
        let buttons = button('时间线', 'timeline', order._id);
        if (!managed() && order.status === 'PENDING_PAYMENT') buttons += button('模拟支付', 'pay', order._id, 'primary') + button('取消', 'cancel', order._id);
        if (!managed() && order.paymentStatus === 'PAID') buttons += button('申请售后', 'apply-after', order._id);
        if (!managed() && order.status === 'READY_FOR_PICKUP' && order.paymentStatus === 'PAID') buttons += button('查看自取码', 'pickup-code', order._id);
        if (managed() && order.paymentStatus === 'PAID') {
          if (order.status === 'PENDING_ACCEPTANCE') buttons += button('接单', 'accept', order._id, 'primary');
          if (order.status === 'ACCEPTED') buttons += button(order.deliveryType === 'pickup' ? '准备自取' : '登记发货', order.deliveryType === 'pickup' ? 'readyForPickup' : 'ship', order._id, 'primary');
          if (['SHIPPING', 'READY_FOR_PICKUP'].includes(order.status)) buttons += button(order.deliveryType === 'pickup' ? '核销自取' : '确认完成', 'complete', order._id, 'primary');
          if (identity === 'owner' && order.status === 'PENDING_ACCEPTANCE') buttons += button('拒单退款', 'reject-order', order._id, 'danger');
        }
        return `<section class="card"><div class="toolbar"><h3>订单 ${esc(order._id.slice(-8))}</h3><span class="pill">${statuses[order.status] || '订单更新'}${order.paymentStatus === 'REFUNDED' ? ' · 已退款' : ''}</span></div><p>${order.items.map(item => esc(item.name) + ' × ' + item.quantity).join('，')}</p><p><strong>${money(order.amounts.totalCents)}</strong> · ${order.deliveryType === 'pickup' ? '到店自取' : '配送'}</p>${order.fulfillment ? `<p class="muted">${esc(order.fulfillment.carrier)} · ${esc(order.fulfillment.trackingNo)}（手工登记）</p>` : ''}<div class="row">${buttons}</div></section>`;
      }).join('') || '<div class="card empty">暂无订单</div>';
    } else if (tab === 'afterSales') {
      view.afterSales = (await activeClient.afterSales.list({ manage: identity === 'owner', limit: 50 })).items;
      html = '<h2>售后</h2>' + (view.afterSales.map(sale => `<section class="card"><div class="toolbar"><h3>售后 ${esc(sale._id.slice(-8))}</h3><span class="pill">${statuses[sale.status]}</span></div><p>申请原因：${esc(sale.reason)}</p>${sale.reviewReason ? '<p class="muted">审核说明：' + esc(sale.reviewReason) + '</p>' : ''}<div class="row">${identity === 'owner' && sale.status === 'REQUESTED' ? button('批准', 'approve-after', sale._id, 'primary') + button('拒绝', 'reject-after', sale._id) : ''}${identity === 'owner' && sale.status === 'APPROVED' ? button('执行模拟退款', 'refund', sale._id, 'primary') : ''}</div></section>`).join('') || '<div class="card empty">暂无售后记录；顾客可在订单中申请</div>');
    } else if (tab === 'statistics') {
      const info = await (await fetch('/demo/state')).json(); const endAt = info.now + 1, startAt = endAt - 86400000;
      const summary = await activeClient.statistics.summary({ startAt, endAt });
      html = `<h2>经营统计</h2><p class="muted">最近24小时的模拟经营数据；退款按发生时间计入。</p><div class="metrics">${[['成交额', summary.grossCents], ['退款额', summary.refundCents], ['净额', summary.netCents]].map(([label, value]) => `<section class="card metric">${label}<strong>${money(value)}</strong></section>`).join('')}</div><section class="card"><h3>有效完成 ${summary.completedOrderCount} 单</h3><p class="muted">以当前仍为已支付的完成订单计算；退款订单从有效销量中排除。</p>${summary.productSales.map(item => `<p>${esc(item.name)}：${item.quantity} 件</p>`).join('') || '<p>暂无有效销量</p>'}</section>`;
    } else if (tab === 'shop') {
      view.shop = await activeClient.shop.get(); const s = view.shop, r = s.shipping;
      html = `<h2>店铺设置</h2><form id="shop-form" class="card grid">${field('name', '店铺名称', s.name)}${field('phone', '联系电话', s.phone)}${field('wechat', '联系账号', s.wechat)}${field('address', '店铺地址', s.address)}${field('deliveryNote', '配送说明', s.deliveryNote)}${field('northernFeeCents', '北方配送费（元）', (r.northernFeeCents / 100).toFixed(2))}${field('otherFeeCents', '其他地区配送费（元）', (r.otherFeeCents / 100).toFixed(2))}${field('northernThresholdCents', '北方包邮门槛（元）', (r.northernThresholdCents / 100).toFixed(2))}${field('otherThresholdCents', '其他地区包邮门槛（元）', (r.otherThresholdCents / 100).toFixed(2))}<button class="primary wide">保存配置</button></form><div class="card"><h3>演示时间</h3><p class="muted">推进15分钟并处理到期订单；不会运行真实云定时任务。</p>${button('推进15分钟', 'advance')}</div>`;
    } else if (tab === 'notifications') {
      const items = (await activeClient.notifications.list({ manage: identity === 'owner', limit: 50 })).items;
      html = '<div class="toolbar"><h2>通知记录</h2>' + (identity === 'owner' ? button('处理演示通知', 'dispatch', '', 'primary') : '') + '</div><p class="muted">发送器为本地测试通道，不联系顾客、群机器人或商家。</p>';
      html += items.map(item => `<section class="card"><div class="row"><strong>${esc(actionNames[item.eventType] || '售后状态更新')}</strong><span class="pill">${statuses[item.status]}</span></div><p class="muted">${esc(new Date(item.createdAt).toLocaleString())} · 尝试 ${item.attempts} 次</p></section>`).join('') || '<div class="card empty">暂无通知</div>';
    }
    if (ticket !== renderEpoch || activeTab !== tab || activeIdentity !== identity) return;
    state = { ...state, ...view };
    $('#content').innerHTML = html;
    if (tab === 'shop') for (const name of ['phone', 'wechat', 'address', 'deliveryNote']) $('#shop-form [name="' + name + '"]').required = false;
  }

  function addressForm(address = {}) {
    state.editAddress = address;
    details(`<h2>${address._id ? '编辑' : '新增'}地址</h2><form id="address-form" class="grid">${field('name', '收件人', address.name || '测试顾客')}${field('phone', '电话', address.phone || '00000000000')}${field('province', '省份', address.province || '内蒙古')}${field('city', '城市', address.city || '测试市')}${field('district', '区县', address.district || '测试区')}${field('detail', '详细地址', address.detail || '虚构地址')}<label class="wide row"><input name="makeDefault" type="checkbox" ${address.isDefault ? 'checked' : ''}>设为默认地址</label><button class="primary wide">保存地址</button></form>`);
  }
  function productForm(product = {}) {
    state.editProduct = product;
    details(`<h2>${product._id ? '编辑' : '新增'}商品</h2><form id="product-form" class="grid">${field('name', '商品名称', product.name || '')}${field('price', '单价（元）', ((product.priceCents || 1000) / 100).toFixed(2))}${field('category', '分类', product.category || '司康')}${field('desc', '描述', product.desc || '演示商品')}<label class="wide row"><input name="isOnSale" type="checkbox" ${product.isOnSale !== false ? 'checked' : ''}>上架</label><p class="muted wide">新增商品库存为0，请保存后单独盘点库存。</p><button class="primary wide">保存商品</button></form>`);
  }
  const cents = value => { if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('金额最多保留两位小数'); const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0')); };
  function showQuote() {
    $('#quote-result').innerHTML = `<div class="card"><p>${attempt.restored ? '已恢复原请求和报价：' : '服务端确认：'}商品 ${money(attempt.quote.subtotalCents)} ＋ 运费 ${money(attempt.quote.shippingCents)} ＝ <strong>${money(attempt.quote.totalCents)}</strong></p><div class="row">${button('确认提交', 'submit-checkout', '', 'primary')}${button('按原请求重试', 'retry-checkout')}</div></div>`;
  }
  async function action(name, id) {
    $('#message').style.display = 'none';
    const order = state.orders?.find(item => item._id === id), sale = state.afterSales?.find(item => item._id === id);
    if (name === 'add-cart') { const cart = await client.cart.get(); const old = cart.items.find(item => item.productId === id); await client.cart.setLine({ productId: id, quantity: (old?.quantity || 0) + 1, expectedVersion: cart.version, requestId: rid('cart') }); message('已加入购物车'); }
    if (name.startsWith('cart-')) { const item = state.cart.items.find(row => row.productId === id); const quantity = name === 'cart-remove' ? 0 : item.quantity + (name === 'cart-plus' ? 1 : -1); await client.cart.setLine({ productId: id, quantity, expectedVersion: state.cart.version, requestId: rid('cart') }); attempt = null; }
    if (name === 'new-address') return addressForm();
    if (name === 'edit-address') return addressForm(state.addresses.find(item => item._id === id));
    if (name === 'remove-address') { const address = state.addresses.find(item => item._id === id); await client.addresses.remove({ addressId: id, expectedVersion: address.version, requestId: rid('address-remove') }); }
    if (name === 'new-product') return productForm();
    if (name === 'edit-product') return productForm(await client.catalog.get(id, { includeUnavailable: true }));
    if (name === 'stock') { const product = await client.catalog.get(id, { includeUnavailable: true }); const value = await ask('盘点后的实物库存（不低于已预留数量）', String(product.onHand)); if (value === null) return; await client.inventory.adjust({ productId: id, onHand: Number(value), expectedVersion: product.inventoryVersion, reason: '本地演示盘点', requestId: rid('stock') }); }
    if (name === 'restore-checkout') { attempt = await recovery.restore(); if (!attempt) { message('没有可恢复的结算'); return render(); } if (state.recoveryDraft.state === 'CONFIRMED') { await attempt.submit(); tab = 'orders'; message('已找回原订单，请核对最新状态'); return render(); } showQuote(); message('已恢复原请求；请核对金额后提交或按原请求重试'); return; }
    if (name === 'discard-checkout') { let acknowledgeUncertain = false, problem = false, latest; try { latest = await recovery.inspect(); } catch (_) { problem = true; } if (problem || ['SUBMITTING', 'UNCERTAIN'].includes(latest?.state)) { const answer = await ask('清理不会取消订单，已核对订单后请输入“已核对”'); if (answer !== '已核对') return; acknowledgeUncertain = true; } await recovery.discard({ acknowledgeUncertain }); attempt = null; message('已清理本地草稿，未取消服务器订单'); }
    if (name === 'submit-checkout' || name === 'retry-checkout') { const restored = attempt.restored, order = await attempt.submit(); let note = ''; if (!restored && !['EXPIRED', 'CANCELLED'].includes(order.status)) { try { await client.cart.clear({ expectedVersion: state.cart.version, requestId: rid('clear') }); } catch (_) { note = '；购物车有更新，请手动核对'; } } else note = '；购物车已保留，请核对'; const warning = attempt.getRecoveryStatus().storageWarning; attempt = null; tab = 'orders'; message((restored ? '已恢复原订单' : '订单已创建，请继续模拟支付') + note + (warning ? '；本地确认记录未保存，下次仍可按原请求找回' : '')); }
    if (name === 'pay') await client.orders.pay(id, { expectedVersion: order.version });
    if (name === 'cancel') await client.orders.cancel(id, { expectedVersion: order.version });
    if (name === 'timeline') { const timeline = await client.orders.timeline({ orderId: id, manage: managed(), limit: 50 }); return details('<h2>订单时间线</h2><ol>' + timeline.items.map(item => `<li>${esc(actionNames[item.action] || '订单更新')}<br><span class="muted">${esc(new Date(item.createdAt).toLocaleString())}</span></li>`).join('') + '</ol>'); }
    if (name === 'pickup-code') { const result = await client.orders.pickupCode(id); return details('<h2>到店自取码</h2><p class="price">' + esc(result.code) + '</p><p>向店员出示此码完成核销。</p>'); }
    if (['accept', 'ship', 'readyForPickup', 'complete'].includes(name)) { const input = { orderId: id, expectedVersion: order.version, requestId: rid(name) }; if (name === 'ship') { input.carrier = await ask('承运方', '测试承运方'); if (input.carrier === null) return; input.trackingNo = await ask('手工运单号', 'DEMO-' + Date.now()); if (input.trackingNo === null) return; } if (name === 'complete' && order.deliveryType === 'pickup') { input.pickupCode = await ask('顾客出示的自取码'); if (input.pickupCode === null) return; } await client.fulfillment[name](input); }
    if (name === 'apply-after') { const reason = await ask('售后申请原因'); if (reason === null) return; await client.afterSales.apply({ orderId: id, reason, requestId: rid('after') }); message('售后已申请'); }
    if (name === 'reject-order') { const reason = await ask('拒单退款原因'); if (reason === null) return; await client.orders.reject({ orderId: id, reason, expectedVersion: order.version, requestId: rid('reject') }); }
    if (name === 'approve-after' || name === 'reject-after') { const reason = await ask('审核说明', name === 'approve-after' ? '同意模拟退款' : '请补充信息'); if (reason === null) return; await client.afterSales.review({ afterSaleId: id, decision: name === 'approve-after' ? 'approve' : 'reject', reason, expectedVersion: sale.version, requestId: rid('review') }); }
    if (name === 'refund') await client.refunds.executeApproved({ afterSaleId: id });
    if (name === 'dispatch') { const result = await post('/demo/dispatch', {}); message('本地测试通道已处理 ' + result.delivered + ' 条通知'); }
    if (name === 'advance') { const result = await post('/demo/advance', {}); message('演示时间已推进15分钟，处理超时 ' + result.expiry.expired + ' 单'); }
    await render();
  }
  document.addEventListener('click', async event => {
    if (switching) return;
    const nav = event.target.closest('[data-tab]'); if (nav) { if (busy) return; tab = nav.dataset.tab; attempt = null; try { await render(); } catch (error) { message(error.message, true); } return; }
    const target = event.target.closest('[data-action]'); if (!target) return;
    target.disabled = true; updateBusy(1); try { await action(target.dataset.action, target.dataset.id); } catch (error) { message(error.message + (error.uncertain ? '；结果待确认，请保留原请求重试' : ''), true); } finally { target.disabled = false; updateBusy(-1); }
  });
  document.addEventListener('submit', async event => {
    event.preventDefault(); if (switching) return; const form = event.target, data = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('button'); submit.disabled = true; updateBusy(1);
    try {
      if (form.id === 'prompt-form') { const resolve = state.promptResolve; state.promptResolve = null; $('#details').close(); resolve(data.value); return; }
      if (form.id === 'quote-form') { attempt = await recovery.prepare({ requestId: rid('checkout'), deliveryType: data.deliveryType, addressId: data.addressId || undefined, remark: data.remark, items: state.cart.items.map(({ productId, quantity }) => ({ productId, quantity })) }); showQuote(); return; }
      if (form.id === 'address-form') { await client.addresses.save({ ...data, addressId: state.editAddress._id || rid('addr'), expectedVersion: state.editAddress.version || 0, requestId: rid('address'), makeDefault: data.makeDefault === 'on' }); $('#details').close(); }
      if (form.id === 'product-form') { await client.catalog.save({ ...data, productId: state.editProduct._id || rid('product'), expectedVersion: state.editProduct.catalogVersion || 0, requestId: rid('product-save'), priceCents: cents(data.price), isOnSale: data.isOnSale === 'on', image: state.editProduct.image || '', isFeatured: state.editProduct.isFeatured || false }); $('#details').close(); }
      if (form.id === 'shop-form') { const shipping = { ...state.shop.shipping }; for (const key of ['northernFeeCents', 'otherFeeCents', 'northernThresholdCents', 'otherThresholdCents']) shipping[key] = cents(data[key]); await client.shop.save({ ...data, shipping, expectedVersion: state.shop.version, requestId: rid('shop'), banners: state.shop.banners }); message('店铺配置已保存'); }
      await render();
    } catch (error) { message(error.message, true); } finally { submit.disabled = false; updateBusy(-1); }
  });
  $('#identity').addEventListener('change', async event => { try { await switchIdentity(event.target.value); message('已切换演示身份'); } catch (error) { message(error.message, true); } });
  function cancelPrompt() { if (state.promptResolve) { const resolve = state.promptResolve; state.promptResolve = null; resolve(null); } }
  $('#close-details').addEventListener('click', () => { cancelPrompt(); $('#details').close(); });
  $('#details').addEventListener('cancel', cancelPrompt);
  fetch('/demo/state').then(response => response.json()).then(info => { $('#identity').value = info.identity; return switchIdentity(info.identity); }).catch(error => message(error.message, true));
})();
