'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// --sqlite 让整套领域测试跑在真实数据库实现上（见 test/support/repository.js）
if (process.argv.includes('--sqlite')) process.env.BAKERY_REPOSITORY = 'sqlite';
const args = process.argv.slice(2).filter(arg => arg !== '--sqlite');
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js'))
  .sort().map(name => 'test/' + name);
const result = spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
