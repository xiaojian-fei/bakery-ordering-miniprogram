'use strict';
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLocalDemo } = require('./local-demo-fixture');

const host = '127.0.0.1';
const roles = ['buyer', 'staff', 'owner'];
const maxBytes = 32768;
const demoPassword = 'LOCAL_DEMO_ONLY';
const root = path.resolve(__dirname, '..');
const makeToken = () => randomBytes(24).toString('hex');

async function startPreviewServer(port = 0) {
  const demo = await createLocalDemo({ liveClock: true });
  const tokens = Object.fromEntries(roles.map(role => [role, makeToken()]));
  const identities = new Map(roles.map(role => [tokens[role], role]));
  const instance = randomBytes(12).toString('hex');
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    const reject = (status, code) => json(status, { success: false, error: { code } });
    try {
      if (req.headers.host !== host + ':' + server.address().port) return reject(403, 'FORBIDDEN');
      if (req.method !== 'POST' || req.url !== '/api') return reject(404, 'INVALID_ACTION');
      const role = identities.get(req.headers['x-preview-token']);
      if (!role) return reject(403, 'FORBIDDEN');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject(415, 'INVALID_REQUEST');
      if (Number(req.headers['content-length']) > maxBytes) return reject(413, 'INVALID_REQUEST');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
          reject(413, 'INVALID_REQUEST');
          return;
        }
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { return reject(400, 'INVALID_REQUEST'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) return reject(400, 'INVALID_REQUEST');
      if (request.action === 'staff.login' && (role === 'buyer' || request.data?.password !== demoPassword)) {
        return reject(200, 'AUTH_FAILED');
      }
      json(200, await demo.handle(request, role));
    } catch (_) {
      if (!res.headersSent && !res.destroyed) reject(500, 'INTERNAL_ERROR');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { server, tokens, instance, url: 'http://' + host + ':' + server.address().port + '/api' };
}

function runtimeSource({ url, instance }, role, token) {
  return `'use strict';
const { createTradeClient } = require('./trade-client');
const { createMiniappRuntime } = require('./miniapp-runtime');
const endpoint = ${JSON.stringify(url)};
const token = ${JSON.stringify(token)};
const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let sequence = 0;
const client = createTradeClient({ send: envelope => new Promise((resolve, reject) => {
  wx.request({
    url: endpoint, method: 'POST', timeout: 10000, dataType: 'json',
    header: { 'content-type': 'application/json', 'x-preview-token': token },
    data: envelope,
    success(response) {
      if (response.statusCode === 200) resolve(response.data);
      else reject(new Error('LOCAL_PREVIEW_HTTP_ERROR'));
    },
    fail: reject
  });
}) });
module.exports = createMiniappRuntime({ client, subjectId: ${JSON.stringify(role + '-demo')},
  requestId: () => 'demo-' + nonce + '-' + (++sequence),
  checkoutNamespace: ${JSON.stringify('bakery.demo.' + instance + '.' + role)} });
`;
}

async function generateProjects(preview, outputRoot) {
  await fs.mkdir(outputRoot, { recursive: true });
  const destination = await fs.mkdtemp(path.join(outputRoot, 'run-'));
  const projects = {};
  for (const role of roles) {
    const project = path.join(destination, role);
    await fs.mkdir(project);
    for (const entry of ['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'pages', 'components', 'services']) {
      await fs.cp(path.join(root, entry), path.join(project, entry), { recursive: true });
    }
    const roleName = { buyer: '顾客', staff: '员工', owner: '店主' }[role];
    const config = { appid: 'touristappid', compileType: 'miniprogram',
      projectname: '烘焙本机演示-' + roleName, setting: { urlCheck: false, es6: true } };
    await fs.writeFile(path.join(project, 'project.config.json'), JSON.stringify(config, null, 2) + '\n');
    const manifestPath = path.join(project, 'app.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.window.navigationBarTitleText = '本机演示 · ' + roleName;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(path.join(project, 'services', 'miniapp-config.js'), runtimeSource(preview, role, preview.tokens[role]));
    projects[role] = project;
  }
  return projects;
}

async function main() {
  const preview = await startPreviewServer(0);
  try {
    const projects = await generateProjects(preview, path.join(root, '.local', 'miniapp-preview'));
    console.log('保持此终端运行。将以下目录分别导入微信开发者工具：');
    console.log('顾客：' + projects.buyer);
    console.log('员工：' + projects.staff);
    console.log('店主：' + projects.owner);
    console.log('员工和店主演示口令：' + demoPassword);
  } catch (error) {
    preview.server.close();
    throw error;
  }
}

if (require.main === module) main().catch(error => {
  console.error('本机演示启动失败：' + (error.code || error.name));
  process.exitCode = 1;
});

module.exports = { startPreviewServer, generateProjects };
