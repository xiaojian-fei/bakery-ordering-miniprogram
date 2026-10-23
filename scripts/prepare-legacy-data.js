'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareLegacyMigration } = require('../cloudfunctions/api/setup/legacy-migration');

async function prepareFiles(argv, { root = path.resolve(__dirname, '..') } = {}) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--input', '--stock', '--out'].includes(key) || !argv[index + 1] || args[key]) throw new Error('INVALID_ARGUMENTS');
    args[key] = argv[index + 1];
  }
  if (!args['--input'] || !args['--stock']) throw new Error('INVALID_ARGUMENTS');
  const name = args['--out'] || 'legacy-migration-plan.json';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('INVALID_OUTPUT_NAME');
  async function readJson(file) {
    const target = path.resolve(root, file);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('INVALID_INPUT_FILE');
    const bytes = await fs.readFile(target);
    let value;
    try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch (_) { throw new Error('INVALID_INPUT_JSON'); }
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const source = await readJson(args['--input']);
  const stock = await readJson(args['--stock']);
  const plan = prepareLegacyMigration(source.value, {
    mode: 'fresh-test-environment', inventoryByProductId: stock.value
  });
  const outputDir = path.join(root, '.local');
  await fs.mkdir(outputDir, { recursive: true });
  const directory = await fs.lstat(outputDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('INVALID_OUTPUT_DIRECTORY');
  const output = path.join(outputDir, name);
  await fs.writeFile(output, JSON.stringify({ sourceSha256: source.sha256, stockSha256: stock.sha256, ...plan }, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { output, ready: plan.ready, products: plan.prepared.products.length,
    addresses: plan.prepared.addresses.length, blockers: plan.blockers.length,
    warnings: plan.warnings.length, excludedOrders: plan.excludedLegacyOrderCount };
}

if (require.main === module) {
  prepareFiles(process.argv.slice(2)).then(result => {
    console.log('迁移准备：', result.ready ? '可供人工核对' : '存在阻断项',
      '；商品', result.products, '；地址', result.addresses, '；阻断', result.blockers,
      '；提醒', result.warnings, '；未导入历史订单', result.excludedOrders);
    console.log('详细结果仅保存在项目.local目录；未连接或写入数据库。');
    process.exitCode = result.ready ? 0 : 2;
  }).catch(error => {
    // 不打印原始JSON、账号、地址、口令或解析器错误片段。
    const known = ['INVALID_ARGUMENTS', 'INVALID_OUTPUT_NAME', 'INVALID_INPUT_FILE',
      'INVALID_INPUT_JSON', 'INVALID_OUTPUT_DIRECTORY'];
    console.error('迁移准备失败：', known.includes(error.message) ? error.message : error.code || 'LOCAL_IO_ERROR');
    process.exitCode = 1;
  });
}

module.exports = { prepareFiles };
