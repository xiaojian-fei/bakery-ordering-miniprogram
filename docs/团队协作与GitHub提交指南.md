# 三人协作与 GitHub 提交指南

更新于 2026-11-13。团队已确认转为独立 Web 系统，采用 Vue 3＋Vite、Node.js 和 SQLite。技术范围见 [Web 重构方案](Web重构方案.md)。

## 1. 当前仓库与工作方式

仓库地址为 https://github.com/xiaojian-fei/bakery-ordering-miniprogram 。当前为公开仓库，默认分支 main。已核实的账号为 xiaojian-fei（管理员）和 bizijian（写入协作者），main 当前未启用分支保护。这是本次查询状态，后续以 GitHub 页面为准。

所有人可以读取公开仓库。团队成员向同一仓库推送任务分支，需要接受协作者邀请并取得写入权限。管理员在 Settings → Collaborators 中按队友本人 GitHub 账号邀请，其余成员使用自己的账号操作。

每人在自己电脑上克隆一份，独立运行后端和数据库。GitHub 同步源代码、数据库结构迁移和虚构种子数据；本机 SQLite 数据文件和上传文件各自保管。多人测试同一套数据属于后续共享测试环境任务。

## 2. 分工与启动顺序

| 模块 | 主要负责人建议 | 负责范围 |
|---|---|---|
| 基础与交易 | A | 项目骨架、HTTP 接口、账号会话、SQLite、计价与库存事务、公共契约 |
| 顾客页面 | B | 商品、详情、购物车、地址、结算、顾客订单和售后申请 |
| 管理页面 | C | 商品库存管理、接单配送、自取核销、售后审核退款、经营统计 |

每人负责自己模块的代码、必要测试和说明。A/B/C 是认领建议，按实际任务调整。审核和合并由三人分担，模块负责人用于协调接口和文件变更。

先由 A 完成 Web 骨架、最小账号与数据库闭环，走一次 PR 并合并 main。随后 B/C 从更新后的 main 分出任务分支。基础尚未就绪时，可以先整理页面、接口需求和验收步骤，使用明确标注的虚构接口数据。

公共接口、数据结构或 shared 文件需要改动时，在对应 Issue/PR 写清原因和影响，邀请受影响模块的一位负责人审核。依赖其他 PR 时写清链接，等依赖合并后再同步 main。

## 3. 每人首次设置

先确认已安装 Git 和团队约定的 Node.js。当前已验证环境为 Node.js 24.19.0，正式迁移时以锁定的版本要求为准。使用 PowerShell 的成员可用 npm.cmd 避免脚本执行策略问题。

```powershell
git clone https://github.com/xiaojian-fei/bakery-ordering-miniprogram.git
cd bakery-ordering-miniprogram
git status
node --version
```

已克隆者继续使用原目录。各人按自己的路径进入仓库，引号中的身份信息替换后执行。

```powershell
git config --local user.name "你自己的 GitHub 用户名"
git config --local user.email "从你自己的 GitHub 邮箱设置页复制的 noreply 邮箱"
git config --local pull.ff only
```

提交邮箱从 https://github.com/settings/emails 获取。每人使用自己的 noreply 邮箱，保留真实贡献归属。账号登录使用自己的 GitHub 凭证，密码、Token 和数据库文件留在本地。

网页端已经完成迁移，不需要安装任何第三方依赖（`package.json` 没有 dependencies）。提交前执行：

```powershell
npm.cmd test          # 255 项自动测试（内存夹具）
npm.cmd run test:sqlite   # 同一批断言跑在真实 SQLite 上
npm.cmd start         # 启动网页端 http://127.0.0.1:8080
```

改动前端或 HTTP 层时再加跑 `npm.cmd run smoke`、`npm.cmd run ui`；改并发或库存逻辑时跑
`npm.cmd run load`（需以 `AUTH_RATE_LIMIT=1000` 启动服务）。详细说明见
[网页端运行与验收](网页端运行与验收.md)。

## 4. 一项任务一个分支

在 Issue 或任务看板中写上负责人、修改范围和通过标准。任务尽量能在半天至两天内独立验收，例如“新增默认地址表单与校验”，避免一条任务包含整套顾客端。

每次开工先检查工作区，上一项工作的修改提交到原任务分支后再切换。

```powershell
git status
git switch main
git pull --ff-only origin main
git switch -c codex/web-b-cart
```

分支名按任务变化，例如 codex/web-foundation、codex/web-b-address、codex/web-c-fulfillment。每人修改自己认领的任务分支，一项新任务使用新分支。

## 5. 提交与推送

提交标题和正文均使用中文，路径、命令和技术名称可保留原文。完成一个可解释的小改动就提交，无需等整个模块结束。

推荐标题包括“功能：新增顾客地址编辑”“修复：取消订单后释放预留库存”“测试：覆盖重复退款请求”“文档：补充本地启动步骤”。正文按需要说明原因、验证结果和遗留问题。

提交前查看 diff，按实际文件逐个加入暂存。下面的文件路径需要替换。

```powershell
git status
git diff
git diff --check
git add -- "你实际修改的文件路径"
git diff --cached
git diff --cached --check
git commit -m "功能：完善购物车数量修改与错误提示"
git push -u origin codex/web-b-cart
```

测试按改动范围执行。页面改动检查正常流程、表单错误和刷新恢复；接口或数据库改动检查权限、失败回滚和必要并发行为。公共交易逻辑变动执行全量业务回归。文档改动检查链接、命令和状态描述。

本地配置、.env、Token、密码、真实用户信息、SQLite 文件（含 -wal/-shm）、备份、uploads、node_modules 和构建产物不加入暂存。数据库接入 PR 要先补齐这些路径的忽略规则，同时提交结构迁移和虚构种子脚本。依赖变动提交对应 package.json 与锁文件。

## 6. PR、审核与合并

推送后打开 GitHub → Pull requests → New pull request，选择 base 为 main，compare 为自己的任务分支。尚未完成时标为 Draft。PR 使用中文标题，填写仓库提供的模板。

每个 PR 由另一位队友审核，通过后由作者自行合并，也可由审核者合并。日常可按 A 审 B、B 审 C、C 审 A 轮换，忙时互换。涉及公共接口或数据库的变更，由受影响模块负责人中的一人审核，一次批准即可。

审核范围聚焦本次差异、模块接口和代表性验收。审核者如实记录自己检查了什么，避免将有限验证写成完成全项目检查。发现阻碍问题就在 PR 下写具体位置、复现步骤或预期结果，作者修复后推送到同一分支，PR 自动更新。

合并前核对以下条件。

- 任务验收标准已满足，PR 描述与最后的代码一致。
- 作者已查看最终 diff，必要检查有实际结果。
- 另一名队友已批准，阻碍问题已解决；批准后再改业务逻辑时请对方补看新增差异。
- 与最新 main 兼容，冲突已解决并完成相应验证。
- PR 中没有真实个人数据或本地配置，未完成事项有明确记录。

优先使用 Create a merge commit，保留每人的原始提交和贡献过程，合并提交的标题与正文也使用中文。若选项受分支策略限制，以团队实际配置为准，并保留作者、PR 和验收记录。main 作为可运行集成版本，模块改动通过 PR 合入。

仓库管理员可以配置 main 分支保护，要求一次他人批准并禁止强推，以工具落实约定。指定必过检查前，先建立并跑通对应 CI。此指南没有创建分支保护或 CI，当前仍按团队流程执行。保护分支是否可用以仓库可见性和账号计划为准。

合并后，所有人更新本地 main，新任务再分支。任务分支可在确认合并后删除，后续开发另开分支。

```powershell
git switch main
git pull --ff-only origin main
```

## 7. 开发中同步 main 和解决冲突

自己的任务分支开发超过一天，或者依赖的接口已合入 main 时，先提交当前修改，再同步。

```powershell
git fetch origin
git merge origin/main
```

若编辑器打开合并说明，填写中文，例如“合并：同步 main 的最新接口”。

出现冲突时，git status 会列出文件。打开文件，结合双方预期整理最终代码，去掉冲突标记，重新运行受影响的检查。需要协助时，在 PR 中附文件和双方意图，由相关负责人一起确认。

```powershell
git status
git add -- "已经解决冲突的文件路径"
git commit -m "合并：解决购物车与最新接口的冲突"
git push
```

暂时无法正确处理时可用 git merge --abort 返回合并前状态，再请队友协助。工作区有未提交内容时先妥善保存，再开始合并。推送被拒绝时先 fetch 并检查是否有人更新同一分支，确认原因后同步，按正常流程再推送。

## 8. 给 Agent 的任务写法

可以复制以下提示，并替换方括号中的任务信息。

> 请先读 AGENTS.md、README.md、docs/Web重构方案.md 和本指南。检查当前分支及未提交修改，在当前任务分支完成【任务】。修改范围为【路径】，依赖接口为【契约】，验收标准为【具体步骤与预期】。公共接口变动请说明影响并保持调用方兼容。执行与改动匹配的检查，按中文提交说明提交和推送，发起或更新 PR。汇报提交号、实际验证和遗留问题，合并按团队审核流程进行。

成员本人核对 Agent 的 diff、测试结果并能解释本次实现。每人提交自己的设计与验证记录，报告据实说明 AI 辅助范围。最终课程评审源码还需同步头歌，核对报告中的地址与最终交付版本。

## 官方参考

- [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)
- [个人仓库协作权限](https://docs.github.com/en/repositories/creating-and-managing-repositories/access-to-repositories)
- [PR 合并方式](https://docs.github.com/en/pull-requests/reference/pull-request-merges)
- [保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
