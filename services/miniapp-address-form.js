'use strict';
const { TradeApiError } = require('./trade-errors');
const fields = ['name', 'phone', 'province', 'city', 'district', 'detail'];
const empty = () => ({ name: '', phone: '', province: '', city: '', district: '', detail: '', region: ['', '', ''], isDefault: false });
const message = error => error instanceof TradeApiError ? error.message : '地址操作失败，请重试';
const deactivate = page => { page._active = false; page._epoch = (page._epoch || 0) + 1; };

function createAddressFormPage({ runtime, wx }) {
  const editor = runtime.addressEditor;
  const editable = page => page.data.formReady && !page.data.loading && !page._saving
    && !page.data.writePending && !page.data.reloadRequired && !page.data.saved;
  function display(page, payload, isDefault, writePending) {
    page._defaultTouched = false; page._initialized = true;
    page.setData({ ...Object.fromEntries(fields.map(field => [field, payload[field]])),
      id: payload.addressId, version: payload.expectedVersion, isDefault,
      region: [payload.province, payload.city, payload.district], formReady: true,
      writePending, deletionPending: false, pendingNeedsRestore: false, reloadRequired: false, saved: false, error: '' });
  }
  function fail(page, error) {
    if (!page._active) return;
    page.setData({ error: message(error), writePending: editor.hasPending(), deletionPending: false,
      ...(['VERSION_CONFLICT', 'ADDRESS_NOT_FOUND', 'FORBIDDEN'].includes(error?.code)
        ? { reloadRequired: true, formReady: false } : {}),
      ...(error?.code === 'ADDRESS_DELETE_RECOVERY_REQUIRED'
        ? { deletionPending: true, saved: false, formReady: false, pendingNeedsRestore: false } : {}),
      ...(['SESSION_CHANGED', 'UNAUTHENTICATED', 'ACCOUNT_DISABLED'].includes(error?.code)
        ? { ...empty(), formReady: false } : {}) });
  }
  async function save(page, work) {
    if (page._saving) return;
    page._saving = true; page.setData({ saving: true, error: '' });
    try {
      const result = await work();
      if (page._active) {
        page.setData({ id: result._id, version: result.version, isDefault: result.isDefault,
          saved: true, writePending: false, pendingNeedsRestore: false, formReady: false });
        wx.showToast({ title: '保存成功', icon: 'success' });
      }
    } catch (error) { fail(page, error); }
    finally { page._saving = false; if (page._active) page.setData({ saving: false }); }
  }
  function input(page, field, event) {
    if (editable(page)) page.setData({ [field]: event.detail.value });
  }
  return {
    data: { unifiedMode: true, ...empty(), id: '', version: 0, loading: false, saving: false,
      formReady: false, writePending: false, pendingNeedsRestore: false, deletionPending: false, reloadRequired: false, saved: false, error: '' },
    onLoad(options = {}) { this._requestedId = options.id || null; },
    async onShow() {
      this._active = true;
      if (!this._initialized) return this.loadAddress();
      const epoch = this._epoch = (this._epoch || 0) + 1;
      try {
        const pending = await editor.getPending();
        if (pending?.kind === 'remove') throw new TradeApiError('ADDRESS_DELETE_RECOVERY_REQUIRED');
        if (this._active && this._epoch === epoch) this.setData({ writePending: Boolean(pending), deletionPending: false,
          pendingNeedsRestore: Boolean(pending && pending.payload.addressId !== this.data.id) });
      } catch (error) { if (this._epoch === epoch) fail(this, error); }
    },
    onHide() { deactivate(this); }, onUnload() { deactivate(this); },
    async loadAddress() {
      if (this._saving) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, formReady: false, error: '' });
      try {
        const pending = await editor.getPending();
        if (!this._active || this._epoch !== epoch) return;
        if (pending?.kind === 'remove') throw new TradeApiError('ADDRESS_DELETE_RECOVERY_REQUIRED');
        if (pending) {
          this.setData({ writePending: true, pendingNeedsRestore: true });
          return;
        }
        const id = this.data.id || this._requestedId;
        if (!id) {
          display(this, { ...empty(), addressId: editor.newId(), expectedVersion: 0 }, false, false);
          return;
        }
        const address = await editor.read(id);
        if (!this._active || this._epoch !== epoch) return;
        if (address?._id !== id || !Number.isSafeInteger(address.version) || address.version < 1
          || typeof address.isDefault !== 'boolean' || fields.some(field => typeof address[field] !== 'string')) {
          throw new TradeApiError('PROTOCOL_ERROR');
        }
        display(this, { ...address, addressId: id, expectedVersion: address.version }, address.isDefault, false);
      } catch (error) { if (this._epoch === epoch) fail(this, error); }
      finally { if (this._active && this._epoch === epoch) this.setData({ loading: false }); }
    },
    async restorePending() {
      if (this._saving) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      try {
        const pending = await editor.getPending();
        if (pending?.kind === 'remove') throw new TradeApiError('ADDRESS_DELETE_RECOVERY_REQUIRED');
        if (this._active && this._epoch === epoch && pending) display(this, pending.payload, pending.displayedDefault, true);
      } catch (error) { if (this._epoch === epoch) fail(this, error); }
    },
    onNameInput(event) { input(this, 'name', event); },
    onPhoneInput(event) { input(this, 'phone', event); },
    onDetailInput(event) { input(this, 'detail', event); },
    onRegionChange(event) {
      if (!editable(this)) return;
      const region = event.detail.value;
      if (Array.isArray(region) && region.length === 3 && region.every(value => typeof value === 'string')) {
        this.setData({ region: [...region], province: region[0], city: region[1], district: region[2] });
      }
    },
    onDefaultChange(event) {
      if (editable(this) && typeof event.detail.value === 'boolean') {
        this._defaultTouched = true; this.setData({ isDefault: event.detail.value });
      }
    },
    submit() {
      if (!editable(this)) return;
      const payload = { addressId: this.data.id, expectedVersion: this.data.version,
        ...Object.fromEntries(fields.map(field => [field, this.data[field]])),
        ...(this._defaultTouched ? { makeDefault: this.data.isDefault } : {}) };
      return save(this, () => editor.save(payload, { displayedDefault: this.data.isDefault }));
    },
    retrySave() {
      if (!this.data.writePending || !this.data.formReady || this.data.pendingNeedsRestore) return;
      return save(this, () => editor.retry());
    },
    backToAddresses() {
      wx.navigateBack({ delta: 1, fail: () => wx.navigateTo({ url: '/pages/address/address' }) });
    }
  };
}
module.exports = { createAddressFormPage };
