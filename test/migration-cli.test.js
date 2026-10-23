'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareFiles } = require('../scripts/prepare-legacy-data');
const { legacyFixture } = require('./support/legacy-fixture');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bakery-migration-'));
  t.after(async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bakery-migration-')) {
      throw new Error('UNEXPECTED_TEMP_PATH');
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'source.json'), JSON.stringify(legacyFixture()));
  await fs.writeFile(path.join(root, 'stock.json'), JSON.stringify({ bread: 12 }));
  return root;
}
const args = ['--input', 'source.json', '--stock', 'stock.json'];

test('迁移文件：保留原文件，结果只写.local且附原文件摘要，不重复覆盖结果', async t => {
  const root = await temporary(t);
  const before = await fs.readFile(path.join(root, 'source.json'), 'utf8');
  const result = await prepareFiles(args, { root });
  assert.equal(result.ready, true);
  const report = JSON.parse(await fs.readFile(result.output, 'utf8'));
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(report.stockSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.prepared.products[0].priceCents, 1190);
  assert.equal(await fs.readFile(path.join(root, 'source.json'), 'utf8'), before);
  await assert.rejects(prepareFiles(args, { root }), error => error.code === 'EEXIST');
});

test('迁移文件：阻断项仍可本地核对，但ready明确为false', async t => {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, 'stock.json'), '{}');
  const result = await prepareFiles([...args, '--out', 'blocked.json'], { root });
  assert.equal(result.ready, false);
  assert.equal(result.blockers, 1);
  assert.equal(JSON.parse(await fs.readFile(result.output, 'utf8')).ready, false);
});

test('迁移文件：拒绝越界输出名、未知参数和非法JSON，不带出原文错误片段', async t => {
  const root = await temporary(t);
  await assert.rejects(prepareFiles([...args, '--out', '../public.json'], { root }), /INVALID_OUTPUT_NAME/);
  await assert.rejects(prepareFiles([...args, '--out', 'CON.json'], { root }), /INVALID_OUTPUT_NAME/);
  await assert.rejects(prepareFiles([...args, '--unknown', 'value'], { root }), /INVALID_ARGUMENTS/);
  await fs.writeFile(path.join(root, 'source.json'), '{"private-fragment":BROKEN');
  await assert.rejects(prepareFiles(args, { root }), error => error.message === 'INVALID_INPUT_JSON');
});
