import { el, clear, pageHead, field, toast, apiError } from '../ui.js';

/**
 * 自助修改密码。
 *
 * 顾客：改密后保持登录，其它设备上的会话被撤销。
 * 员工/店主：密码版本变化会让既有员工会话失效，改密后需要重新登录。
 */
export async function render(ctx, mount) {
  const session = ctx.session;
  const isStaff = Boolean(session.staffRole);
  const minLength = isStaff ? 12 : 8;

  const current = el('input', {
    type: 'password', autocomplete: 'current-password', required: true, placeholder: '请输入当前密码'
  });
  const next = el('input', {
    type: 'password', autocomplete: 'new-password', required: true, placeholder: `至少 ${minLength} 位字符`
  });
  const confirm = el('input', {
    type: 'password', autocomplete: 'new-password', required: true, placeholder: '再次输入新密码'
  });
  const message = el('p', { style: 'min-height:20px;margin:0;color:#a8443a' }, '');
  const submit = el('button', { class: 'primary' }, '保存新密码');

  const fail = text => { message.textContent = text; };

  submit.addEventListener('click', async () => {
    fail('');
    const currentValue = current.value;
    const nextValue = next.value;
    if (!currentValue || !nextValue) return fail('请填写当前密码与新密码');
    if (nextValue.length < minLength) return fail(`新密码至少 ${minLength} 位字符`);
    if (nextValue !== confirm.value) return fail('两次输入的新密码不一致');
    if (nextValue === currentValue) return fail('新密码不能与当前密码相同');

    submit.disabled = true;
    submit.textContent = '保存中…';
    try {
      const response = await fetch('/api/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentValue, newPassword: nextValue })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, '修改失败，请稍后重试'));
      if (body.reauthRequired) {
        ctx.forceLogout('密码已修改，请用新密码重新登录');
        return;
      }
      toast(body.revokedSessions > 0
        ? `密码已修改，其它 ${body.revokedSessions} 个登录已失效`
        : '密码已修改', 'ok');
      ctx.navigate('#/');
    } catch (error) {
      fail(error.message || '修改失败，请稍后重试');
      submit.disabled = false;
      submit.textContent = '保存新密码';
    }
  });

  clear(mount);
  mount.appendChild(el('p', { style: 'margin:0 0 14px' }, el('a', { href: '#/' }, '← 返回')));
  mount.appendChild(pageHead('修改密码', `当前账号：${session.username || session.openid}　（${isStaff ? '员工' : '顾客'}）`));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '设置新密码'),
    el('div', { class: 'grid', style: 'gap:14px;max-width:420px' },
      field('当前密码', current),
      field('新密码', next, `至少 ${minLength} 位字符`),
      field('确认新密码', confirm)),
    message,
    el('div', { class: 'actions', style: 'margin-top:16px' }, submit)));

  mount.appendChild(el('div', { class: 'card' },
    el('h2', {}, '修改后会发生什么'),
    el('ul', { style: 'margin:0;padding-left:20px;color:#6b5a46;line-height:1.9' },
      el('li', {}, '当前密码错误时不会改动任何数据。'),
      el('li', {}, '其它设备上的登录会立即失效，需要重新登录。'),
      isStaff
        ? el('li', {}, '员工与店主身份会在改密后失效，需要用新密码重新登录才能继续履约或管理操作。')
        : el('li', {}, '当前这台设备会保持登录状态。'))));

  current.focus();
}