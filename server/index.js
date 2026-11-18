'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openRepository, ensureOwner, ensureCatalog } = require('./db');
const { createApplication } = require('../core/application');
const { StaffAuthService } = require('../core/domain/staff-auth-service');
const { NotificationJob } = require('../core/jobs/notification-job');
const { OrderExpiryJob } = require('../core/jobs/order-expiry-job');
const { SessionStore } = require('./sessions');
const { Accounts } = require('./accounts');
const { createHttpServer } = require('./http');

/**
 * 组装网页端：SQLite 仓储 → 业务核心 → 会话与账号 → HTTP。
 * 业务核心（core/）不感知 HTTP，传输层只负责把 Cookie 解析成可信 openid。
 */
async function createServer({ config = loadConfig(), log = console.log } = {}) {
  const repository = await openRepository({ dbFile: config.dbFile, log });
  const owner = await ensureOwner(repository, {
    ownerOpenid: config.ownerOpenid,
    ownerUsername: config.ownerUsername,
    ownerPassword: config.ownerPassword
  });
  await ensureCatalog(repository, { log });

  const clock = Date.now;
  const application = createApplication({
    repository, clock,
    // 只信任服务端会话解析出来的 openid；请求体里的身份字段一律不采信。
    resolveIdentity: async context => ({ openid: context.openid })
  });
  const staffAuth = new StaffAuthService(repository, { clock });
  const sessions = new SessionStore({
    repository, clock,
    ttlMs: config.sessionTtlMs,
    cookieName: config.cookieName,
    staffCookieName: config.staffCookieName,
    secure: config.secureCookies
  });
  const accounts = new Accounts({ repository, staffAuth, sessions, clock });

  // 通知通道：本地落盘记录，不连接任何外部 webhook。
  const notificationFile = path.join(path.dirname(config.dbFile), 'notifications.log');
  const send = async message => {
    await fs.appendFile(notificationFile, JSON.stringify({ ...message, sentAt: clock() }) + '\n');
    return { delivered: true };
  };
  const jobs = {
    notification: new NotificationJob({ repository, clock, send }),
    expiry: new OrderExpiryJob({
      clock,
      findCandidates: options => repository.findExpiredOrders(options),
      expireOrder: orderId => application.expireOrder(orderId)
    })
  };

  const server = createHttpServer({ config, application, accounts, sessions, repository, jobs, log });
  return { server, repository, application, accounts, sessions, staffAuth, jobs, owner, config };
}

async function main() {
  const config = loadConfig();
  const log = (...args) => console.log(...args);
  const { server, repository, jobs, owner, sessions } = await createServer({ config, log });

  if (owner.created && owner.generatedPassword) {
    log('');
    log('=== 首个店主账号已创建 ===');
    log(`用户名：${owner.username}`);
    log(`初始口令：${owner.generatedPassword}`);
    log('该口令只在本次启动显示一次，请立即登录并修改；也可用 OWNER_PASSWORD 环境变量指定。');
    log('');
  }

  let timer = null;
  let purging = false;
  if (config.jobsIntervalMs > 0) {
    timer = setInterval(async () => {
      if (purging) return;
      purging = true;
      try {
        const expiry = await jobs.expiry.run();
        const notification = await jobs.notification.run({ limit: 20 });
        await sessions.purgeExpired();
        if (expiry.expired > 0 || notification.delivered > 0) {
          log(`后台任务：超时关闭 ${expiry.expired} 单，通知投递 ${notification.delivered} 条`);
        }
      } catch (error) {
        log('后台任务失败：' + (error && error.message ? error.message : String(error)));
      } finally {
        purging = false;
      }
    }, config.jobsIntervalMs);
    timer.unref();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  log(`网页端已启动：http://${config.host}:${config.port}`);
  log('顾客可自助注册；员工与店主使用店主分配的账号登录。Ctrl+C 停止。');

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    log(`收到 ${signal}，正在关闭…`);
    if (timer) clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    repository.close();
    log('已关闭，数据已保存在 ' + config.dbFile);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { server, repository };
}

if (require.main === module) {
  main().catch(error => {
    console.error('启动失败：' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}

module.exports = { createServer, main };