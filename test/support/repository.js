'use strict';
const { MemoryRepository } = require('./memory-repository');
const { SqliteRepository } = require('../../server/db/sqlite-repository');

// 通过 BAKERY_REPOSITORY=sqlite 把整套领域测试切换到真实数据库实现，
// 用同一批断言验证两种仓储的外部契约一致。每个夹具得到独立的 :memory: 数据库。
class SqliteTestRepository extends SqliteRepository {
  constructor(seed = {}) {
    super(seed, { file: ':memory:' });
  }
}

const mode = process.env.BAKERY_REPOSITORY || '';
if (mode && mode !== 'sqlite') throw new Error('BAKERY_REPOSITORY 只支持 sqlite 或留空');
const Repository = mode === 'sqlite' ? SqliteTestRepository : MemoryRepository;

module.exports = { Repository, MemoryRepository, SqliteRepository, SqliteTestRepository };