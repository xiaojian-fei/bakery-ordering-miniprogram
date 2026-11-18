import { el, clear, money, pageHead, empty, errorToast, toast, requestId } from '../ui.js';

const EMOJI = Object.freeze({
  司康: '🥯', 饼干: '🍪', 吐司: '🍞', 蛋糕: '🍰', 挞派: '🥧', 面包: '🥖'
});

const thumbOf = product => (product.image && product.image.startsWith('/uploads/')
  ? el('div', { class: 'thumb', style: `background-image:url("${product.image}")` })
  : el('div', { class: 'thumb' }, EMOJI[product.category] || '🥐'));

async function addToCart(ctx, product, amount = 1) {
  const cart = await ctx.api.cart.get();
  const current = cart.items.find(item => item.productId === product._id)?.quantity || 0;
  const quantity = current + amount;
  if (quantity > 99) throw new Error('单个商品最多 99 件');
  await ctx.api.cart.setLine({
    productId: product._id, quantity, expectedVersion: cart.version, requestId: requestId()
  });
  await ctx.refreshCartCount();
}

export async function render(ctx, mount, param, route) {
  if (route === 'product') return detail(ctx, mount, param);
  return list(ctx, mount);
}

async function list(ctx, mount) {
  let keyword = '';
  let category = '';

  clear(mount);
  const grid = el('div', { class: 'grid products' }, el('p', { class: 'loading' }, '加载中…'));
  const search = el('input', { type: 'search', placeholder: '搜索商品名称', style: 'max-width:260px' });
  const chips = el('div', { class: 'actions' });

  const head = pageHead('今日出炉', '按分类浏览，加入购物车后可直接结算。');
  mount.appendChild(head);
  mount.appendChild(el('div', { class: 'actions', style: 'margin-bottom:16px' }, search, chips));
  mount.appendChild(grid);

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { keyword = search.value.trim(); load(); }, 260);
  });

  async function load() {
    clear(grid).appendChild(el('p', { class: 'loading' }, '加载中…'));
    let data;
    try {
      data = await ctx.api.catalog.list({
        ...(keyword ? { keyword } : {}),
        ...(category ? { category } : {}),
        limit: 50
      });
    } catch (error) {
      clear(grid).appendChild(el('div', { class: 'card' },
        el('p', {}, '商品加载失败：' + (error.message || '请稍后重试')),
        el('button', { onclick: load }, '重试')));
      return;
    }
    renderChips(data.items);
    clear(grid);
    if (data.items.length === 0) {
      grid.appendChild(empty(keyword || category ? '没有匹配的商品，换个关键词试试。' : '暂无可售商品。'));
      return;
    }
    for (const product of data.items) grid.appendChild(card(product));
  }

  function renderChips(items) {
    const categories = [...new Set(items.map(item => item.category).filter(Boolean))].sort();
    clear(chips);
    if (categories.length === 0) return;
    chips.appendChild(chip('全部', ''));
    for (const name of categories) chips.appendChild(chip(name, name));
  }

  function chip(label, value) {
    return el('button', {
      class: 'small' + (category === value ? ' primary' : ''),
      onclick: () => { category = value; load(); }
    }, label);
  }

  function card(product) {
    const button = el('button', { class: 'primary small' }, '加入购物车');
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await addToCart(ctx, product);
        toast('已加入购物车', 'ok');
      } catch (error) {
        errorToast(error);
      } finally {
        button.disabled = false;
      }
    });
    const soldOut = product.available <= 0;
    button.disabled = soldOut;
    if (soldOut) button.textContent = '已售罄';
    return el('article', { class: 'product' },
      thumbOf(product),
      el('div', { class: 'body' },
        el('div', { class: 'row' },
          el('a', { class: 'name', href: '#/product/' + product._id }, product.name),
          product.isFeatured ? el('span', { class: 'tag' }, '招牌') : null),
        el('div', { class: 'desc' }, product.desc || product.category || ''),
        el('div', { class: 'row' },
          el('span', { class: 'price' }, money(product.priceCents)),
          el('span', { class: 'tag' }, soldOut ? '售罄' : '可售 ' + product.available))),
      el('div', { class: 'body', style: 'padding-top:0' }, button));
  }

  await load();
}

async function detail(ctx, mount, productId) {
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  let product;
  try {
    product = await ctx.api.catalog.get(productId);
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' },
      el('h2', {}, '无法打开该商品'),
      el('p', {}, error.message || '请返回列表重试'),
      el('a', { class: 'button', href: '#/' }, '返回商品列表')));
    return;
  }

  let quantity = 1;
  const value = el('span', { class: 'value' }, quantity);
  const less = el('button', { class: 'small', onclick: () => { if (quantity > 1) { quantity -= 1; value.textContent = quantity; } } }, '－');
  const more = el('button', { class: 'small', onclick: () => { if (quantity < 99) { quantity += 1; value.textContent = quantity; } } }, '＋');
  const add = el('button', { class: 'primary' }, '加入购物车');
  add.addEventListener('click', async () => {
    if (add.disabled) return;
    add.disabled = true;
    try {
      await addToCart(ctx, product, quantity);
      toast('已加入购物车', 'ok');
    } catch (error) {
      errorToast(error);
    } finally {
      add.disabled = false;
    }
  });
  if (product.available <= 0) { add.disabled = true; add.textContent = '已售罄'; }

  clear(mount);
  mount.appendChild(el('p', { style: 'margin:0 0 14px' }, el('a', { href: '#/' }, '← 返回商品列表')));
  mount.appendChild(el('div', { class: 'card' },
    el('div', { class: 'grid two' },
      thumbOf(product),
      el('div', {},
        el('h1', { style: 'margin:0 0 6px;font-size:22px' }, product.name),
        el('p', { style: 'margin:0 0 8px;color:#8a7a68' }, product.category || ''),
        el('div', { class: 'price', style: 'font-size:24px;color:#c8874a;font-weight:700;margin-bottom:10px' },
          money(product.priceCents)),
        el('p', { style: 'line-height:1.8' }, product.desc || '暂无描述'),
        el('div', { class: 'actions', style: 'margin-top:18px' },
          el('div', { class: 'qty' }, less, value, more), add),
        el('p', { class: 'desc', style: 'margin-top:12px;color:#8a7a68;font-size:13px' },
          '当前可售 ' + product.available + ' 件')))));
}