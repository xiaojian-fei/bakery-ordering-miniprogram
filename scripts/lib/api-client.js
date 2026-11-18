'use strict';

/**
 * 验收脚本共用的最小 HTTP 客户端：带 Cookie 罐，直接说业务动作。
 * 只用于 scripts/ 下的冒烟、界面与并发验收，不参与服务端运行。
 */
class ApiClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async call(method, pathname, body) {
    const response = await fetch(this.base + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => k + '=' + v).join('; ') } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
    return { status: response.status, body: json, text };
  }

  async session() {
    return (await this.call('GET', '/api/session')).body;
  }

  async login(username, password) {
    const result = await this.call('POST', '/api/login', { username, password });
    if (result.status !== 200) throw new Error('登录失败：' + JSON.stringify(result.body));
    return this.session();
  }

  async register(username, password) {
    const result = await this.call('POST', '/api/register', { username, password });
    if (result.status !== 201) throw new Error('注册失败：' + JSON.stringify(result.body));
    return this.session();
  }

  /** 调用业务动作，失败直接抛出（带上服务端返回的错误码）。 */
  async action(name, data = {}) {
    const result = await this.call('POST', '/api/action', { action: name, data });
    const body = result.body || {};
    if (body.success !== true) {
      const error = new Error((body.error && body.error.message) || '接口调用失败');
      error.code = body.error && body.error.code;
      error.status = result.status;
      throw error;
    }
    return body.data;
  }

  /** 调用业务动作但返回原始结果，供"预期失败"的用例使用。 */
  async attempt(name, data = {}) {
    const result = await this.call('POST', '/api/action', { action: name, data });
    const body = result.body || {};
    return { ok: body.success === true, data: body.data, code: body.error && body.error.code, status: result.status };
  }
}

module.exports = { ApiClient };