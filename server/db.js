'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { SqliteRepository } = require('./db/sqlite-repository');
const { OwnerBootstrap } = require('../core/setup/owner-bootstrap');

/** 打开数据库文件，目录不存在时自动创建，并把表结构与索引补齐。 */
async function openRepository({ dbFile, log = () => {} }) {
  if (dbFile !== ':memory:') await fs.mkdir(path.dirname(dbFile), { recursive: true });
  const repository = new SqliteRepository({}, { file: dbFile });
  log(`数据库已就绪：${dbFile}（${repository.info.collections} 个集合，${repository.info.indexes} 个索引）`);
  return repository;
}

/**
 * 首个店主初始化。与原有的 OwnerBootstrap 一致：只在全新库上创建，
 * 已有标记时不重设口令；这里额外补写网页登录需要的 username。
 */
async function ensureOwner(repository, { ownerOpenid, ownerUsername, ownerPassword, clock = Date.now }) {
  const bootstrap = new OwnerBootstrap(repository, { clock });
  const generated = !ownerPassword;
  const password = ownerPassword || randomBytes(15).toString('hex');
  const result = await bootstrap.initialize({ ownerOpenid, password });
  await repository.transaction(async tx => {
    const user = await tx.get('users', ownerOpenid);
    if (user && user.username !== ownerUsername) {
      await tx.set('users', ownerOpenid, { ...user, username: ownerUsername, updatedAt: clock() });
    }
  });
  return { created: result.changed, username: ownerUsername, generatedPassword: generated ? password : null };
}

const CATALOG_SEED = Object.freeze([
  { _id: 'scone-berry', name: '莓果司康', category: '司康', priceCents: 1250, desc: '黄油司康裹蓝莓与蔓越莓，出餐前回烤。', onHand: 30, isFeatured: true },
  { _id: 'cookie-butter', name: '黄油曲奇', category: '饼干', priceCents: 800, desc: '发酵黄油曲奇，独立小包装。', onHand: 60 },
  { _id: 'bread-milk', name: '北海道牛奶吐司', category: '吐司', priceCents: 2200, desc: '淡奶油吐司，整条约 450 克。', onHand: 20, isFeatured: true },
  { _id: 'cake-roll', name: '抹茶生乳卷', category: '蛋糕', priceCents: 3800, desc: '宇治抹茶蛋糕卷，需冷藏保存。', onHand: 12 },
  { _id: 'tart-egg', name: '葡式蛋挞', category: '挞派', priceCents: 600, desc: '现烤蛋挞，单只装。', onHand: 80 },
  { _id: 'bagel-plain', name: '原味贝果', category: '面包', priceCents: 900, desc: '低温发酵贝果，适合早餐。', onHand: 25 }
]);

/** 首次启动写入演示商品；不覆盖已有商品。 */
async function ensureCatalog(repository, { clock = Date.now, log = () => {} } = {}) {
  const created = await repository.transaction(async tx => {
    const existing = await tx.query('products', { filters: [], orderBy: [{ field: '_id', direction: 'asc' }], limit: 1 });
    if (existing.length > 0) return 0;
    const now = clock();
    for (const item of CATALOG_SEED) {
      await tx.set('products', item._id, {
        _id: item._id,
        name: item.name,
        category: item.category,
        priceCents: item.priceCents,
        desc: item.desc,
        image: '',
        isOnSale: true,
        isFeatured: item.isFeatured === true,
        onHand: item.onHand,
        reserved: 0,
        inventoryVersion: 0,
        catalogVersion: 0,
        createdAt: now,
        updatedAt: now
      });
    }
    return CATALOG_SEED.length;
  });
  if (created > 0) log(`已写入 ${created} 个演示商品`);
  return created;
}

module.exports = { openRepository, ensureOwner, ensureCatalog, CATALOG_SEED };