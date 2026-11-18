import { el, clear, pageHead, empty, errorToast, toast, requestId, field } from '../ui.js';

const newAddressId = () => 'addr-' + Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export async function render(ctx, mount) {
  clear(mount).appendChild(el('p', { class: 'loading' }, '加载中…'));
  let page;
  try {
    page = await ctx.api.addresses.list({ limit: 50 });
  } catch (error) {
    clear(mount).appendChild(el('div', { class: 'card' }, el('p', {}, error.message || '地址加载失败')));
    return;
  }

  let editing = null;

  const draw = () => {
    clear(mount);
    mount.appendChild(pageHead('收货地址', '配送订单必须选择一个地址。',
      el('button', { class: 'primary', onclick: () => { editing = { blank: true }; draw(); } }, '新增地址')));

    if (page.items.length === 0) {
      mount.appendChild(el('div', { class: 'card' }, empty('还没有收货地址。')));
    }
    for (const address of page.items) {
      const setDefault = el('button', { class: 'ghost small' }, address.isDefault ? '默认地址' : '设为默认');
      setDefault.disabled = address.isDefault;
      setDefault.addEventListener('click', () => save({
        addressId: address._id, expectedVersion: address.version,
        name: address.name, phone: address.phone, province: address.province,
        city: address.city, district: address.district, detail: address.detail,
        makeDefault: true
      }));

      const remove = el('button', { class: 'danger small' }, '删除');
      remove.addEventListener('click', async () => {
        if (!window.confirm('删除后不可恢复，确定删除该地址？')) return;
        remove.disabled = true;
        try {
          await ctx.api.addresses.remove({
            addressId: address._id, requestId: requestId(), expectedVersion: address.version
          });
          toast('地址已删除', 'ok');
          await render(ctx, mount);
        } catch (error) {
          errorToast(error);
          remove.disabled = false;
        }
      });

      mount.appendChild(el('div', { class: 'card' },
        el('div', { class: 'actions', style: 'justify-content:space-between' },
          el('div', {},
            el('div', { class: 'name' }, address.name, '　', el('span', { class: 'desc' }, address.phone)),
            el('div', { class: 'desc', style: 'color:#8a7a68' },
              address.province, address.city, address.district, address.detail),
            address.isDefault ? el('span', { class: 'tag', style: 'margin-top:6px' }, '默认') : null),
          el('div', { class: 'actions' },
            setDefault,
            el('button', { class: 'small', onclick: () => { editing = { ...address }; draw(); } }, '编辑'),
            remove))));
    }

    if (editing) mount.appendChild(form(editing));
  };

  async function save(payload) {
    try {
      await ctx.api.addresses.save({ ...payload, requestId: requestId() });
      toast('地址已保存', 'ok');
      editing = null;
      await render(ctx, mount);
    } catch (error) {
      errorToast(error);
    }
  }

  function form(target) {
    const value = key => target[key] || '';
    const name = el('input', { value: value('name'), placeholder: '收件人姓名' });
    const phone = el('input', { value: value('phone'), placeholder: '联系电话' });
    const province = el('input', { value: value('province'), placeholder: '如 北京市 / 广东省' });
    const city = el('input', { value: value('city'), placeholder: '城市' });
    const district = el('input', { value: value('district'), placeholder: '区/县' });
    const detail = el('input', { value: value('detail'), placeholder: '街道门牌等详细地址' });
    const makeDefault = el('input', { type: 'checkbox', checked: target.isDefault === true });
    const submit = el('button', { class: 'primary' }, '保存地址');

    submit.addEventListener('click', async () => {
      const payload = {
        addressId: target.blank ? newAddressId() : target._id,
        expectedVersion: target.blank ? 0 : target.version,
        name: name.value.trim(), phone: phone.value.trim(), province: province.value.trim(),
        city: city.value.trim(), district: district.value.trim(), detail: detail.value.trim(),
        makeDefault: makeDefault.checked
      };
      if (!payload.name || !payload.phone || !payload.province || !payload.city
        || !payload.district || !payload.detail) {
        toast('请填写完整的地址信息', 'error');
        return;
      }
      submit.disabled = true;
      await save(payload);
      submit.disabled = false;
    });

    return el('div', { class: 'card' },
      el('h2', {}, target.blank ? '新增地址' : '编辑地址'),
      el('div', { class: 'form-grid' },
        field('收件人', name), field('电话', phone), field('省份', province),
        field('城市', city), field('区县', district), field('详细地址', detail)),
      el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:14px' },
        makeDefault, el('span', {}, '设为默认地址')),
      el('div', { class: 'actions', style: 'margin-top:16px' },
        submit,
        el('button', { onclick: () => { editing = null; draw(); } }, '取消')));
  }

  draw();
}