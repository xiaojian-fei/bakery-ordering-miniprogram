import { el, clear, field, toast } from '../ui.js';

const USERNAME_HINT = '3～32 位字母、数字或 _ . -';

/** 未登录时的入口：登录与注册切换。 */
export function render(ctx, mount) {
  let mode = 'login';
  clear(mount);

  const message = el('p', { class: 'desc', style: 'color:#a8443a;min-height:20px;margin:0' }, '');
  const fail = text => { message.textContent = text; };

  function draw() {
    clear(mount);
    const username = el('input', { name: 'username', autocomplete: 'username', required: true, placeholder: '请输入用户名' });
    const password = el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '请输入密码' });
    const confirm = mode === 'register'
      ? el('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, placeholder: '再次输入密码' })
      : null;

    const submit = el('button', { class: 'primary', type: 'submit' }, mode === 'login' ? '登录' : '注册并登录');

    const form = el('form', {
      onsubmit: async event => {
        event.preventDefault();
        fail('');
        const name = username.value.trim();
        const pass = password.value;
        if (!name || !pass) return fail('请填写用户名和密码');
        if (mode === 'register' && confirm.value !== pass) return fail('两次输入的密码不一致');
        submit.disabled = true;
        submit.textContent = mode === 'login' ? '登录中…' : '注册中…';
        try {
          if (mode === 'login') {
            const session = await ctx.login(name, pass);
            toast('欢迎回来，' + (session.username || name), 'ok');
            // 用 ctx.navigate 而不是直接改 hash：hash 本来就等于目标值时不会触发 hashchange。
            ctx.navigate(session.staffRole === 'owner' ? '#/owner' : session.staffRole ? '#/staff' : '#/');
            return;
          }
          await ctx.register(name, pass);
          toast('注册成功，已自动登录', 'ok');
          ctx.navigate('#/');
        } catch (error) {
          fail(error && error.message ? error.message : '操作未完成，请重试');
        } finally {
          submit.disabled = false;
          submit.textContent = mode === 'login' ? '登录' : '注册并登录';
        }
      }
    },
    el('h1', {}, mode === 'login' ? '登录' : '注册顾客账号'),
    el('p', { class: 'hint' }, mode === 'login'
      ? '顾客可自助注册；店员与店主使用店主分配的账号。'
      : '注册后可在本店下单、查看订单与申请售后。'),
    el('div', { class: 'grid', style: 'gap:14px' },
      field('用户名', username, mode === 'register' ? USERNAME_HINT : null),
      field('密码', password, mode === 'register' ? '至少 8 位字符' : null),
      confirm ? field('确认密码', confirm) : null),
    message,
    el('div', { class: 'actions', style: 'margin-top:16px' }, submit));

    mount.appendChild(el('div', { class: 'auth' },
      el('div', { class: 'card' }, form),
      el('p', { class: 'switch' },
        mode === 'login' ? '还没有账号？' : '已有账号？',
        el('button', {
          type: 'button',
          onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); }
        }, mode === 'login' ? '注册顾客账号' : '返回登录'))));
    username.focus();
  }

  draw();
}