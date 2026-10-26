# A：交易核心交付与联调清单

更新日期：2026-10-26。对应三人开发方案中A的职责；本清单记录本地实现和待接入项，不代替整项目验收或成绩承诺。本轮经用户授权已辅助实现B/C离线服务，原分工和实际贡献仍需如实区分。

## 本地已实现

| 需求 | A的实现 | 验证位置 |
|---|---|---|
| FR-01 身份和三角色 | 可信主体注入、员工口令/会话、授权撤销、对象归属与动作白名单 | staff-auth.test.js、application.test.js |
| FR-04 运费和地址归属 | 可信报价、运费阈值、本人地址校验和快照 | order-core.test.js |
| FR-05 计价/下单/预留 | 整数分、服务端查价、参数去重、库存约束与版本、事务日志 | order-core.test.js |
| FR-06 交易后续 | 模拟支付成功/失败、本人取消、到期释放、批量超时、店主拒单退款 | payment-refund.test.js、merchant-rejection.test.js、order-expiry-job.test.js |
| FR-08 退款原子操作 | 基于C的APPROVED售后整单模拟退款、阶段库存策略、拒单/售后互斥 | payment-refund.test.js、merchant-rejection.test.js |
| FR-09 库存调整 | 店主调整、预留保护、版本冲突、去重和操作流水 | inventory-service.test.js |
| 公共接口与集成 | application工厂、统一错误包、后台超时入口、客户端会话/业务封装、结算重试与本地贯通 | application.test.js、trade-client.test.js、checkout-attempt.test.js、trade-client-integration.test.js |
| 部署准备 | 全新环境初始店主原子写入协议、旧价格/地址预检、显式库存、历史订单排除及本地文件工具 | owner-bootstrap.test.js、legacy-migration.test.js、migration-cli.test.js |

目前全量233项本地测试通过，[10月23日记录](tests/本地核心验收-20261023.md)保留原163项里程碑，[本轮验收](tests/本地全组验收-20261026.md)新增服务48项、结算恢复12项及微信缓存适配10项。失败回滚和竞争用例使用内存事务模型；不能声称真实数据库事务、50并发用户或≤2秒查询已经通过。公共客户端已可按[接入说明](客户端交易接口接入.md)使用，真实云/生产send传输适配仍待后端入口明确。

## B接入时需要做的事

商品/购物车/地址/店铺服务和公共客户端已实现，先审查[全组接口与数据契约](本地全组接口与数据契约.md)，以下重点为原微信页面接入与人工复核，不再要求从零重写相同服务。

1. 商品字段映射为priceCents、onHand、reserved、inventoryVersion；商品编辑不能直接覆盖库存字段，库存页面调用inventory.adjust。
2. 结算推荐使用client.prepareCheckout生成固定意图，先展示服务端报价，用户确认后submit。每次新结算生成新requestId；网络重试沿用原attempt.retry，不能自动换ID重建订单。页面重启后的意图恢复仍需B实现。
3. 支付页明确写“模拟支付”；使用orders.pay的outcome区分成功和失败。处理PRICE_CHANGED、OUT_OF_STOCK、VERSION_CONFLICT后要求刷新确认，不能后台自动改价提交。
4. 顾客页通过orders.get读取自己的订单，展示取消原因、已退款状态和支付截止时间。倒计时只控制显示，不能由客户端直接释放库存或修改状态。
5. 后台会话可使用公共client.staff.login/logout封装，只在内存保留令牌；客户端角色只影响按钮显示，实际授权以服务端为准。send真实传输适配等后端入口确定后接入。

## C接入时需要做的事

履约/售后/统计服务及其离线演示已实现，可参照[任务表](本地开发任务表-20261026.md)和[本地架构](本地架构与业务模型.md)复核设计。下列清单中的服务职责已有辅助实现，后续重点为审查、原微信页面接入、实际部署与端到端验收。

1. 履约服务调用nextStatus并在事务中提交订单版本与事件，接单与退款竞争时重新检查状态。不能调用OrderService.change去接单或直接在页面写状态。
2. 店主工作台拒单调用orders.reject，携requestId、expectedVersion和原因；店员不能执行退款。
3. 售后申请/审批流程由C实现；审核输出受保护的APPROVED记录，再调用refunds.executeApproved。该退款原子操作不代表审核本身已实现。
4. 统计区分成功收款、成功退款和净额；refunds包含AFTER_SALE和MERCHANT_REJECTION两类来源，不依赖每笔退款都有afterSaleId。支付失败和未支付订单不算收入。
5. 本地联调可以使用MemoryRepository与application工厂，不需要云权限；正式演示还需接真实身份、数据库与页面。

## A后续仍需完成的集成

以下工作需要后端方向和访问权限明确后验证，当前没有实施或完成承诺：

- 真实可信身份解析、生产事务repository及冲突处理；首个店主模块已实现，管理员身份确认、口令输入和真实环境执行仍待接入。
- 微信云函数或独立HTTP启动入口、传输超时/解包与字节数限制、登录频率控制；公共客户端业务封装已完成，实际send网络适配未实现。
- 旧数据预检已实现；实际导入器、部署回滚、集合权限与索引、超时任务真实查询及定时触发、运行监控仍待实现和验证。
- 三角色端到端验证、真实并发库存争用和课程要求的性能测试。
- 根据真实部署结果更新设计图、测试报告、部署手册与视频材料。

没有云权限时，可继续推进B/C的纯业务服务和页面改造准备；无需为了这些工作先把项目整体迁移出微信云开发。
