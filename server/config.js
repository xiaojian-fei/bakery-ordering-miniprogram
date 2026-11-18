'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min}～${max} 之间的整数`);
  }
  return value;
}

function text(env, name, fallback, pattern) {
  const value = env[name] === undefined || env[name] === '' ? fallback : env[name];
  if (pattern && !pattern.test(value)) throw new Error(`环境变量 ${name} 格式不合法`);
  return value;
}

/**
 * 网页端运行配置。全部通过环境变量覆盖，不读取任何微信云配置。
 */
function loadConfig(env = process.env, overrides = {}) {
  const config = {
    root: ROOT,
    host: text(env, 'HOST', '127.0.0.1'),
    port: integer(env, 'PORT', 8080, 1, 65535),
    dbFile: path.resolve(ROOT, text(env, 'DB_FILE', 'data/bakery.sqlite')),
    uploadDir: path.resolve(ROOT, text(env, 'UPLOAD_DIR', 'data/uploads')),
    webDir: path.join(ROOT, 'web'),
    // 首个店主由部署侧初始化；未提供密码时随机生成并只在首次启动打印一次。
    ownerOpenid: text(env, 'OWNER_OPENID', 'owner', /^[A-Za-z0-9_-]{1,80}$/),
    ownerUsername: text(env, 'OWNER_USERNAME', 'owner', /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/),
    ownerPassword: env.OWNER_PASSWORD || '',
    sessionTtlMs: integer(env, 'SESSION_TTL_HOURS', 12, 1, 24 * 30) * 60 * MINUTE,
    maxBodyBytes: integer(env, 'MAX_BODY_KB', 256, 16, 4096) * 1024,
    maxUploadBytes: integer(env, 'MAX_UPLOAD_KB', 2048, 64, 10240) * 1024,
    jobsIntervalMs: integer(env, 'JOBS_INTERVAL_SECONDS', 60, 0, 3600) * 1000,
    // 注册与登录的按来源限流；压测或批量开号时可临时放宽。
    authRateLimit: integer(env, 'AUTH_RATE_LIMIT', 20, 1, 100000),
    authRateWindowMs: integer(env, 'AUTH_RATE_WINDOW_SECONDS', 300, 1, 86400) * 1000,
    secureCookies: env.SECURE_COOKIES === '1',
    cookieName: 'bakery_sid',
    staffCookieName: 'bakery_staff',
    log: (...args) => console.log(...args),
    ...overrides
  };
  if (config.ownerPassword && config.ownerPassword.length < 12) {
    throw new Error('OWNER_PASSWORD 至少需要 12 个字符');
  }
  if (config.sessionTtlMs < MINUTE || config.sessionTtlMs > 30 * DAY) {
    throw new Error('会话有效期超出允许范围');
  }
  return Object.freeze(config);
}

module.exports = { loadConfig };