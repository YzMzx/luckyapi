# LuckyAPI 二次开发约定

本指南适用于整个仓库。当前部署模型是单管理员、单上游、单 SQLite 数据文件。接手需求时，先找到同模块的一条现有调用链，从页面追到服务端过程、数据写入和相邻测试，再确定改动范围。

## 本地启动

使用与 [Dockerfile](Dockerfile) 一致的 Node 20 系列，选择满足 Vite 7 要求的 20.19 或更高补丁版本。仓库跟踪 npm 锁文件，容器构建也会从它导入依赖。克隆后在根目录执行：


```powershell
npm ci
# 首次配置时执行，已有 .env 时保留现有配置
Copy-Item .env.example .env
# 编辑 .env 后启动
npm run dev
```

首次启动前，按 [.env.example](.env.example) 填写独立的管理员密码，将 `SQLITE_PATH` 指向本地开发库。默认地址为 `http://localhost:3000`，管理端为 `/admin`。Vite 会把 API 和网关请求交给 Hono；修改联调入口时检查 [Vite 配置](vite.config.ts) 的路径匹配。

## 按功能选择入口

| 需求 | 修改路径与约定 |
| --- | --- |
| 页面与导航 | 从 [App.tsx](src/App.tsx) 查找路由，再进入对应的会员控制台、管理端或玩法页面。同一操作沿用所属布局、现有 UI 组件和 [tRPC 客户端](src/providers/trpc.tsx)。新增页面时同步检查导航入口与直接访问。 |
| 站内业务接口 | 在对应领域的 `api/routers/` 中扩展过程。新增领域时在 [总路由](api/router.ts) 注册。输入用 Zod 校验，客户端沿用推导出的接口类型。前后端都用的规则、单位换算与类型放在 `contracts/`，保持可独立测试。 |
| 对外 HTTP 接口 | OAuth 回调和网关分别从 [oauth.ts](api/routes/oauth.ts) 与 [gateway.ts](api/routes/gateway.ts) 进入，由 [boot.ts](api/boot.ts) 挂载。网关改动要核对已有客户端依赖的状态码、响应结构、流式返回和结算行为。 |
| 身份与运营策略 | 从 [auth.ts](api/auth.ts) 选用已有的登录、待注册、会员或管理员过程。服务端从会话确定操作者，涉及他人资源时校验归属；模块开关、冻结与限额沿用 [policies.ts](api/queries/policies.ts)。按同类管理操作记录审计。 |

## 修改数据与账务

1. **表结构同时覆盖新库与旧库。** 修改 [Drizzle 表定义](db/schema.ts) 时，同步检查 [连接初始化](api/queries/connection.ts) 中的建表 SQL、索引和旧数据升级逻辑。生产启动会调用 `getDb()`；单独执行 `db:generate` 或 `db:push` 无法覆盖已有部署的启动升级路径。用空库和含旧数据的临时库分别启动，再重启一次，检查字段、索引、默认值及回填结果。可参考 [注册迁移测试](api/queries/registration-migration.test.ts)。
2. **金额明确单位，余额变动与流水原子提交。** 金融计算沿用 [finance.ts](contracts/finance.ts) 的整数最小单位，1 个金额单位等于 1,000,000 个最小单位。与已有余额字段交互时显式换算。涉及永久余额或限时额度时优先复用 [额度逻辑](api/queries/credit-grants.ts)。需要记录流水时，在同一个同步 SQLite 事务内先更新余额，再调用 [recordTx](api/queries/ledger.ts)，传入实际变动额。它会读取更新后的余额作为 `balanceAfter`。
3. **重复请求与规则变更要有明确结果。** 转账、借贷等可重试写操作沿用同类过程的 `requestId` 和去重逻辑；变更费率时保留已签合同的规则快照。用重复提交、余额不足及事务回滚验证账目。页面操作成功后沿用 [余额刷新机制](src/lib/balance-sync.ts)。

## 验证与交付

- 开发中先运行最接近的用例，例如 `npm test -- api/routers/balance-ledger.test.ts`。数据库测试在导入连接模块前设置独立临时 `SQLITE_PATH`，可用 `appRouter.createCaller` 验证权限、返回值及落库结果，参见 [余额流水测试](api/routers/balance-ledger.test.ts)。
- 代码变更交付前运行 `npm run check`、`npm run lint`、`npm test`、`npm run build`。现有 [Vitest 配置](vitest.config.ts) 只收集 API 和 contracts 下匹配的测试，页面改动应另行在浏览器走通操作、错误提示和刷新后的状态。
- 修改定时回收或额度过期逻辑时，用独立测试库验证生产入口。相关定时任务在 [boot.ts](api/boot.ts) 的生产分支注册，单跑开发服务器无法验证调度。
- 遵循 [Prettier 配置](.prettierrc)，格式化限于本次修改的文件。配置项变动同步更新 [.env.example](.env.example) 和 [部署说明](README.md)。真实密钥、Cookie、请求日志、数据库和备份留在仓库外。
- 交付说明写明用户可见变化、旧数据影响、已执行的检查和未验证事项。涉及部署升级时，说明备份与恢复步骤。
