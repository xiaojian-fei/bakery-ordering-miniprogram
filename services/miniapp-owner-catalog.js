'use strict';
const { TradeApiError } = require('./trade-errors');

const errorText = error => error instanceof TradeApiError ? error.message : '商品操作失败，请重试';
const denied = error => ['FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED', 'SESSION_CHANGED'].includes(error?.code);
const emptyForm = () => ({ name: '', price: '', desc: '', category: '', image: '', isOnSale: false,
  isFeatured: false, onHand: '', reason: '' });
const priceText = cents => (cents / 100).toFixed(2);

function createOwnerCatalogPage({ runtime, wx }) {
  const client = runtime.client;
  let writing = false, pending = null;
  async function authorize() {
    await runtime.assertIdentity();
    if (client.getSession()?.role !== 'owner') throw new TradeApiError('FORBIDDEN');
  }
  return {
    data: { rows: [], cursor: null, keyword: '', loading: false, error: '', notice: '',
      busy: false, pending: false, editing: null, form: emptyForm() },
    onShow() {
      this._visit = {};
      this.setData({ busy: writing, pending: Boolean(pending), notice: '' });
      return this.refreshProducts();
    },
    onHide() {
      this._visit = null;
      this._query = null;
      this.setData({ rows: [], cursor: null, editing: null, form: emptyForm() });
    },
    onUnload() { this.onHide(); pending = null; },
    enterKeyword(event) { this.setData({ keyword: event.detail.value }); },
    searchProducts() {
      if (writing) return;
      this._keyword = this.data.keyword.trim().slice(0, 60);
      return this.refreshProducts();
    },
    refreshProducts() {
      this.setData({ rows: [], cursor: null, editing: null, form: emptyForm() });
      return this.readProducts(null);
    },
    moreProducts() {
      if (!writing && !this.data.loading && this.data.cursor) return this.readProducts(this.data.cursor);
    },
    async readProducts(cursor) {
      if (!this._visit) return;
      const query = this._query = {};
      const current = () => this._visit && this._query === query;
      const keyword = this._keyword;
      this.setData({ loading: true, error: '' });
      try {
        await authorize();
        const result = await client.catalog.list({ includeUnavailable: true, limit: 10,
          ...(keyword ? { keyword } : {}), ...(cursor ? { cursor } : {}) });
        await authorize();
        if (!current()) return;
        const rows = new Map(this.data.rows.map(row => [row._id, row]));
        for (const row of result.items) rows.set(row._id, { ...row, price: priceText(row.priceCents) });
        this.setData({ rows: [...rows.values()], cursor: result.nextCursor });
      } catch (error) {
        if (current()) this.productError(error);
      } finally {
        if (current()) this.setData({ loading: false });
      }
    },
    productError(error) {
      if (denied(error)) {
        this._query = null;
        this.setData({ rows: [], cursor: null, editing: null, form: emptyForm(), loading: false });
      }
      this.setData({ error: errorText(error) });
    },
    newProduct() {
      if (!writing && !pending) this.setData({ editing: { type: 'catalog', row: null }, form: emptyForm(), error: '', notice: '' });
    },
    editProduct(event) {
      const { id, type } = event.currentTarget.dataset;
      const row = this.data.rows.find(product => product._id === id);
      if (!row || writing || pending || !['catalog', 'stock'].includes(type)) return;
      this.setData({ editing: { type, row }, form: { name: row.name, price: row.price, desc: row.desc,
        category: row.category, image: row.image, isOnSale: row.isOnSale, isFeatured: row.isFeatured,
        onHand: String(row.onHand), reason: '' }, error: '', notice: '' });
    },
    closeProductForm() { if (!writing) this.setData({ editing: null, form: emptyForm() }); },
    editProductField(event) {
      const key = event.currentTarget.dataset.key;
      if (writing || !this.data.editing || !Object.prototype.hasOwnProperty.call(this.data.form, key)) return;
      this.setData({ form: { ...this.data.form, [key]: event.detail.value } });
    },
    submitProduct() {
      const editing = this.data.editing;
      if (!editing || writing || pending) return;
      const { row, type } = editing;
      const form = this.data.form;
      if (type === 'stock') {
        const onHand = Number(form.onHand), reason = form.reason.trim();
        if (!/^\d+$/.test(form.onHand) || !Number.isSafeInteger(onHand) || onHand < row.reserved || !reason || reason.length > 200) {
          this.setData({ error: '库存须为不低于已预留数量的整数，且须填写调整原因。' }); return;
        }
        return this.writeProduct({ type, payload: { productId: row._id, onHand, reason, expectedVersion: row.inventoryVersion } });
      }
      const name = form.name.trim(), rawPrice = form.price.trim();
      const [yuan, fraction = ''] = rawPrice.split('.');
      const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
      if (!name || name.length > 100 || !/^\d+(\.\d{1,2})?$/.test(rawPrice) || !Number.isSafeInteger(cents) || cents < 1) {
        this.setData({ error: '请填写商品名称和大于零的价格，价格最多两位小数。' }); return;
      }
      return this.writeProduct({ type, payload: {
        ...(row ? { productId: row._id } : {}), expectedVersion: row?.catalogVersion ?? 0,
        name, priceCents: cents, desc: form.desc.trim(), category: form.category.trim(), image: form.image.trim(),
        isOnSale: form.isOnSale, isFeatured: form.isFeatured
      } });
    },
    retryProduct() { if (pending) return this.writeProduct(pending, true); },
    async writeProduct(operation, retry = false) {
      const visit = this._visit;
      if (!visit || writing) return;
      const current = () => this._visit === visit;
      const stock = operation.type === 'stock';
      writing = true;
      this.setData({ busy: true, error: '', notice: '' });
      try {
        await authorize();
        if (!current()) return;
        if (!retry) {
          const confirmed = await new Promise((resolve, reject) => wx.showModal({
            title: stock ? '确认调整库存' : '确认保存商品',
            content: stock ? '实物库存将设为 ' + operation.payload.onHand + ' 件。' : '请核对商品资料及上下架状态。',
            success: result => resolve(result.confirm === true), fail: reject
          }));
          if (!confirmed || !current()) return;
          await authorize();
          if (!current()) return;
          const requestId = runtime.newCheckoutRequestId();
          pending = { type: operation.type, payload: { ...operation.payload, requestId,
            productId: operation.payload.productId || requestId } };
        }
        if (stock) await client.inventory.adjust(pending.payload);
        else await client.catalog.save(pending.payload);
        pending = null;
        await authorize();
        if (current()) {
          await this.refreshProducts();
          if (current() && !this.data.error) this.setData({ notice: stock ? '库存已更新。' : '商品已保存。' });
        }
      } catch (error) {
        if (!error.uncertain && !denied(error)) pending = null;
        if (current()) {
          if (['VERSION_CONFLICT', 'RESERVED_STOCK_CONFLICT'].includes(error.code)) await this.refreshProducts();
          if (current()) {
            if (error.uncertain && pending) this.setData({ error: '保存结果待核对，请重试原操作。' });
            else this.productError(error);
          }
        }
      } finally {
        writing = false;
        if (this._visit) this.setData({ busy: false, pending: Boolean(pending) });
      }
    }
  };
}

module.exports = { createOwnerCatalogPage };
