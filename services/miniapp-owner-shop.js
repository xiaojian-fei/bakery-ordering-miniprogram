'use strict';
const { TradeApiError } = require('./trade-errors');

const textFields = [
  { key: 'name', label: '门店名称', max: 100 }, { key: 'phone', label: '电话', max: 40 },
  { key: 'wechat', label: '微信', max: 80 }, { key: 'address', label: '地址', max: 300 },
  { key: 'deliveryNote', label: '配送说明', max: 300 }
];
const moneyFields = [
  { key: 'northernThresholdCents', label: '指定地区包邮门槛' }, { key: 'northernFeeCents', label: '指定地区运费' },
  { key: 'otherThresholdCents', label: '其他地区包邮门槛' }, { key: 'otherFeeCents', label: '其他地区运费' }
];
const keys = new Set([...textFields.map(row => row.key), ...moneyFields.map(row => row.key), 'provinces', 'banners']);
const showError = error => error instanceof TradeApiError ? error.message : '门店配置操作失败，请重试';
const denied = error => ['FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED', 'SESSION_CHANGED'].includes(error?.code);
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

function view(result) {
  const form = { provinces: result.shipping.northernProvinces.join('\n'), banners: result.banners.join('\n') };
  for (const { key } of textFields) form[key] = result[key];
  for (const { key } of moneyFields) form[key] = (result.shipping[key] / 100).toFixed(2);
  return form;
}

function payload(form, expectedVersion) {
  const shipping = { northernProvinces: [...new Set(lines(form.provinces))] };
  const banners = lines(form.banners);
  const result = { expectedVersion, shipping, banners };
  for (const { key, max } of textFields) {
    result[key] = form[key].trim();
    if (result[key].length > max) throw new Error('门店资料超出长度限制。');
  }
  if (!result.name) throw new Error('请输入门店名称。');
  if (!shipping.northernProvinces.length || shipping.northernProvinces.length > 30
    || shipping.northernProvinces.some(name => name.length > 30)) throw new Error('请填写 1 至 30 个地区，每行一个。');
  if (banners.length > 8 || banners.some(url => url.length > 1000 || !/^(https:\/\/|cloud:\/\/|\/images\/)/.test(url))) {
    throw new Error('轮播图最多 8 张，每行填写一个有效图片地址。');
  }
  for (const { key, label } of moneyFields) {
    const value = form[key].trim();
    const [yuan, fraction = ''] = value.split('.');
    const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
    if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(cents)) {
      throw new Error(label + '须为非负金额，最多两位小数。');
    }
    shipping[key] = cents;
  }
  return result;
}

function createOwnerShopPage({ runtime, wx }) {
  const client = runtime.client;
  let pending = null, writing = false;
  async function authorize() {
    await runtime.assertIdentity();
    if (client.getSession()?.role !== 'owner') throw new TradeApiError('FORBIDDEN');
  }
  return {
    data: { textFields, moneyFields, form: null, version: null, loading: false, busy: false, pending: false, error: '', notice: '' },
    onShow() {
      this._visit = {};
      this.setData({ pending: Boolean(pending), busy: writing, notice: '' });
      return this.loadShop();
    },
    onHide() { this._visit = null; this._query = null; this.setData({ form: null, version: null }); },
    onUnload() { this.onHide(); pending = null; },
    async loadShop() {
      if (!this._visit) return;
      const query = this._query = {};
      const current = () => this._visit && this._query === query;
      this.setData({ form: null, version: null, error: '', loading: true });
      try {
        await authorize();
        const result = await client.shop.get();
        await authorize();
        if (current()) this.setData({ form: view(result), version: result.version });
      } catch (error) {
        if (current()) this.setData({ error: showError(error) });
      } finally {
        if (current()) this.setData({ loading: false });
      }
    },
    editShopField(event) {
      const key = event.currentTarget.dataset.key;
      if (!writing && !pending && this.data.form && keys.has(key)) {
        this.setData({ form: { ...this.data.form, [key]: event.detail.value } });
      }
    },
    saveShop() {
      if (writing || pending || !this.data.form) return;
      let input;
      try { input = payload(this.data.form, this.data.version); }
      catch (error) { this.setData({ error: error.message }); return; }
      return this.writeShop(input);
    },
    retryShop() { if (pending) return this.writeShop(pending, true); },
    async writeShop(input, retry = false) {
      const visit = this._visit;
      if (!visit || writing) return;
      const current = () => this._visit === visit;
      writing = true;
      this.setData({ busy: true, error: '', notice: '' });
      try {
        await authorize();
        if (!current()) return;
        if (!retry) {
          const accepted = await new Promise((resolve, reject) => wx.showModal({
            title: '保存门店配置', content: '新运费将用于之后的报价和下单。', success: result => resolve(result.confirm === true), fail: reject
          }));
          if (!accepted || !current()) return;
          await authorize();
          if (!current()) return;
          pending = { ...input, requestId: runtime.newCheckoutRequestId() };
        }
        await client.shop.save(pending);
        pending = null;
        if (current()) {
          await this.loadShop();
          if (current() && !this.data.error) this.setData({ notice: '门店配置已保存。' });
        }
      } catch (error) {
        if (!error.uncertain && !denied(error)) pending = null;
        if (current()) {
          if (error.code === 'VERSION_CONFLICT') await this.loadShop();
          if (current()) this.setData({ ...(denied(error) ? { form: null, version: null } : {}),
            error: error.uncertain && pending ? '保存结果待核对，请重试原操作。' : showError(error) });
        }
      } finally {
        writing = false;
        if (this._visit) this.setData({ busy: false, pending: Boolean(pending) });
      }
    }
  };
}

module.exports = { createOwnerShopPage };
