<p align="center">
  <img src="docs/luckyapi-logo.png" width="112" height="112" alt="LuckyAPI 标识" />
</p>

<h1 align="center">LuckyAPI</h1>

<p align="center">
  自托管的社区 API 运营与互动平台
</p>

<p align="center">
  将 OpenAI 兼容网关、额度账务、运营控制、社区玩法与分类榜单整合在一个系统中。
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-v1.0.8-8b5e16" />
  <img alt="deployment" src="https://img.shields.io/badge/deployment-Docker-2496ED?logo=docker&logoColor=white" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Self--hosted-0f766e" />
  <img alt="stack" src="https://img.shields.io/badge/stack-React%20%2B%20TypeScript-3178C6" />
  <img alt="license" src="https://img.shields.io/badge/license-No%20open--source%20license-6b7280" />
</p>

<p align="center">
  <a href="#快速部署">快速部署</a>
  ·
  <a href="#功能全景">功能全景</a>
  ·
  <a href="#技术架构">技术架构</a>
  ·
  <a href="SECURITY.md">安全报告</a>
  ·
  <a href="https://linux.do">Linux.do 社区</a>
</p>

---

## 项目简介

LuckyAPI 面向需要自建社区 API 服务的个人或小型运营团队。它不只是一个接口转发层，还把用户登录、密钥管理、模型定价、额度结算、调用监控、金融互动、娱乐玩法和后台控制串成了一套完整流程。

项目采用单管理员、单上游架构，默认使用 SQLite，适合通过 Docker 在单台服务器快速部署和维护。

## 核心亮点

- **一体化运营**：API 网关、用户体系、账务、活动、榜单和管理后台使用同一套数据与权限模型。
- **OpenAI 兼容**：统一管理上游地址、模型价格、分组、API Key、额度和请求日志。
- **精确账务**：金额使用最小货币单位计算，支持转账、借贷、手续费、限制策略和规则快照。
- **社区互动**：内置签到、抽奖、视频红包、老虎机和决斗玩法。
- **数据可见**：提供调用量、成功率、Token、扣费、延迟、TTFT 以及分类榜单。
- **运营可控**：支持模块开关、用户策略、权限冻结、会话与密钥管理及操作审计。
- **响应式后台**：管理端支持深色/浅色主题、折叠侧栏和移动端布局。

## 功能全景

| 模块 | 主要能力 |
| --- | --- |
| 账户与认证 | Linux.do Connect OAuth、首次注册、账户合并、会话管理 |
| API 运营 | OpenAI 兼容网关、API Key、模型定价、分组、额度与并发限制 |
| 调用监控 | 请求/响应日志、Token、扣费、成功率、错误率、延迟与 TTFT |
| 金融运营 | 转账、借贷、手续费、每日限额、未偿上限与合同规则快照 |
| 娱乐运营 | 签到、抽奖、视频红包、老虎机、决斗 |
| 榜单中心 | 综合、API、金融、娱乐分类榜单及个人排名 |
| 管理后台 | 运营开关、用户策略、OAuth、金融规则、审计日志和主题切换 |

### Bybit 模拟合约

打开 `/contracts`，可以查看管理员已开放品种（默认 **BTCUSDT、ETHUSDT**）的 K 线，并在 1、3、5、15 分钟之间切换，默认 1 分钟，使用逐仓保证金模拟做多、做空。LuckyAPI 服务端直接轮询 Bybit 官方公开 REST 行情，部署时只需允许访问 `https://api.bybit.com`，无需 Bybit API Key。成交、持仓和结算均记录在站内。

交易表单提供市价、限价、条件市价与条件限价。市价单按 Bybit 的公开订单簿（每侧最多 50 档）逐档计算成交均价，手续费和保证金按各档成交额之和计算。市价开仓在滑点范围内不能全额成交时拒单，手动市价平仓可部分成交。限价单只用符合限价的深度，不能全额成交时继续等待；条件单按标记价触发，触发后按相应单型处理。同一快照中已模拟成交的深度不会再次使用。后台每 5 秒检查挂单撮合和强平，使用当轮的新鲜盘口和标记价格，不使用 K 线收盘价，也不保证捕捉两次检查之间的短暂触价。手动市价平仓不需要等到下一轮。触发强平后锁定仓位，等待足量的新鲜深度再执行，不回退到买一、卖一或历史标记价。K 线按当前品种显示本人持仓的预估强平线；以标记价触发，不代表成交价。挂单不预先冻结资金或仓位，最终撮合时再检查余额、可平数量和风险限额，未成交的挂单可在「我的委托」中撤销。

管理员可在 `/admin/contracts-settings` 设置开仓杠杆区间（支持 1× 至 100× 的整数，旧配置默认 1× 至 5×）。玩家在区间内自选倍数，实际最高倍数不超过 Bybit 合约上限。设置变更不修改已有仓位，也不限制平仓；新开仓、加仓和开仓挂单成交按当前区间校验。

使用数量输入框或百分比滑杆选择下单量。开仓表单的「计算」仅预估数量、成本和强平价；逐仓持仓行的平仓弹窗可用「计算收益」预估本次平仓净盈亏、手续费、释放保证金和到账金额。两者都不会发单，也不锁定成交价。所有交易均为站内模拟，不发送 Bybit 真实委托。

在「逐仓持仓」可手动追加保证金。预览并确认后，系统将可用模拟金转入该仓位，不改变持仓数量、开仓均价和杠杆档位，不收手续费或消耗订单簿深度。确认时以最新标记价检查；已触发强平的仓位不能追加。成功后，持仓和 K 线上的预估强平价会更新。

添加品种：在 `/admin/contracts-settings` 输入完整 Bybit 代码（如 `NVDAUSDT`），查询并核对合约规格后添加、保存。仅支持当前可交易且价格和数量精度受系统支持的 USDT 线性永续合约。单个品种可设置为「仅平仓」，用于暂停新增仓位；有持仓或未结束委托时不可移除。

部署前请在服务器测试公开行情：`curl "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT"`。正常响应应为 HTTP 200 且 `retCode` 为 0。如果接口限流、行情过期或返回地区限制（HTTP 403），系统不会用缓存价成交；已缓存的 K 线仅用于查看。

管理员可在 `/admin/contracts-settings` 设置每 1 单位永久余额可换入的模拟金数量，以及兑回手续费百分比。默认 1:1,000、兑回手续费 5%。同一比例双向使用；保存新规则不改变玩家持有的模拟金数量，但会改变已有模拟金今后可兑回的余额。玩家预览至确认期间如遇规则变化，必须重新预览。例：比例设为 1:2,000、兑回费率 2.5% 时，兑回 20,000 模拟金折合 10 单位余额，扣 0.25 后实际到账 9.75。

持仓广场按合约分别查看公开持仓，各表独立分页，并显示在线状态、标记价和浮动盈亏。实时盈亏榜是独立页面，可从合约页进入 `/contracts/live`。该榜每 5 秒按 Bybit 标记价刷新，将每位玩家所有未平仓合约的浮动盈亏相加，按总额从高到低统一排名（盈利、持平和亏损均入榜），不包含已实现盈亏、手续费和资金费。任何仓位缺少有效报价时，该玩家的总额待估值，不参与排名。

榜单中心的「合约」分类包含周结算排行、爆仓亏损榜和平仓盈利榜。周结算以北京时间每周一 00:00 的账户权益为快照，00:05 起归档上一周的盈利榜和亏损榜。爆仓亏损累计扣除该次手续费后的强平损失；平仓盈利统计主动平仓的净额，同周期内亏损平仓会抵减盈利。两个成交榜均以模拟金展示，不统计未平仓浮盈。管理员可在 `/admin/contracts-settings` 选择开放品种，控制换入和交易开关，并设置每用户及全平台的开仓名义价值上限。首次配置使用[环境变量示例](.env.example)中的两个开关作为默认值。

### 会员等级经验

每个业务日首次签到固定获得 200 EXP，签到奖励的 USD 也计收益经验。每获得 1 USD 净收益计 100 EXP，每通过 API Key 实际消费 1 USD 计 10 EXP。不足 1 EXP 的部分跨笔累计。例如签到获得 0.25 USD 时，本次共得 225 EXP。

合约模拟金兑回先用扣除当次手续费后的实际到账额抵扣该用户尚未收回的换入本金，只有超出的净盈利计收益经验。分批兑回继续抵扣同一笔本金；未兑回的浮盈不计经验。其他奖励和兑换码按入账额计算，游戏按单局净赢额计算，放贷按实收税后利息计算。转账、借还本金和退款均不计收益经验。常规升级默认从新发生的签到和流水开始计分。管理员可以主动[用本站原 SQLite 补算，在副本中按历史首达时间重排限定铭牌](docs/level-backfill.md)。

## 技术架构

```text
浏览器 / 移动端
       │
React + TypeScript + Vite
       │
Hono + tRPC API
       ├── SQLite + Drizzle ORM
       ├── Linux.do Connect OAuth
       └── OpenAI 兼容单上游
```

主要技术栈：

- React 19、TypeScript、Vite、Tailwind CSS
- Hono、tRPC、Zod
- Drizzle ORM、SQLite
- Vitest、ESLint、Docker Compose

## 快速部署

### 准备部署目录

在已安装 Docker 和 Compose v2 的服务器上创建部署目录。以下文件和命令均使用同一目录。

创建 `.env`，从 [GitHub Packages](https://github.com/users/YzMzx/packages/container/package/luckyapi) 复制目标镜像的标签，填入 `IMAGE_TAG`。将 `ADMIN_PASSWORD` 设为独立的高强度密码，并运行 `chmod 600 .env` 限制文件访问。

```dotenv
IMAGE_TAG=
ADMIN_PASSWORD=
```

### 配置 Docker Compose

将以下模板保存为 `compose.yaml`。

```yaml
services:
  app:
    image: "ghcr.io/yzmzx/luckyapi:${IMAGE_TAG:?Set IMAGE_TAG in .env}"
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - luckydraw-data:/app/data
    environment:
      ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      LINUXDO_CLIENT_ID: ${LINUXDO_CLIENT_ID:-}
      LINUXDO_CLIENT_SECRET: ${LINUXDO_CLIENT_SECRET:-}
      LINUXDO_PRIMARY_ORIGIN: ${LINUXDO_PRIMARY_ORIGIN:-}
      PERP_DEPOSITS_ENABLED: ${PERP_DEPOSITS_ENABLED:-1}
      PERP_TRADING_ENABLED: ${PERP_TRADING_ENABLED:-1}
      SEVEN_PICK_ENABLED: ${SEVEN_PICK_ENABLED:-0}
      SEVEN_PICK_RFC3161: ${SEVEN_PICK_RFC3161:-0}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

volumes:
  luckydraw-data:
```

### 启动与验证

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

服务显示 `healthy` 后，在部署主机访问 `http://localhost:3000`，管理入口为 `/admin`。若调整了 `PORT`，请使用对应端口。启动异常时，运行 `docker compose logs --tail=100 app` 查看日志。

对外提供服务时，配置 HTTPS 反向代理并转发 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。启用 Linux.do 登录时，在 `.env` 中填写下表的三项 OAuth 配置，并在 OAuth 应用中登记 `https://你的域名/api/oauth/callback`。

### 停止与升级

`docker compose down` 会保留挂载到 `/app/data` 的 SQLite 数据卷。请勿在需要保留数据时使用 `down -v`。升级前运行 `docker compose stop app`，备份整个 `luckydraw-data` 卷和 `.env`。然后在原部署目录更新 `IMAGE_TAG`，重新执行启动与验证命令。

## 关键配置

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `IMAGE_TAG` | GitHub Packages 上已发布的镜像标签 | **是** |
| `ADMIN_USERNAME` | 初始管理员用户名 | 否，默认 `admin` |
| `ADMIN_PASSWORD` | 初始管理员密码 | **是** |
| `LINUXDO_CLIENT_ID` | Linux.do OAuth Client ID | 使用 OAuth 时 |
| `LINUXDO_CLIENT_SECRET` | Linux.do OAuth Client Secret | 使用 OAuth 时 |
| `LINUXDO_PRIMARY_ORIGIN` | 唯一可信站点 Origin | 使用 OAuth 时 |
| `SQLITE_PATH` | SQLite 数据文件路径 | 否 |
| `PORT` | 对外映射端口 | 否，默认 `3000` |
| `SEVEN_PICK_ENABLED` | 设为 `1` 开启七星寻宝生产运行（还须启用已生效的后台配置） | 否，默认 `0`、只预览；见[七星寻宝运行手册](./docs/seven-pick-development.md) |
| `SEVEN_PICK_RFC3161` | 设为 `1` 启用封盘摘要的可选时间凭证，不影响开奖或派奖 | 否，默认 `0` |

应用环境变量示例见 [`.env.example`](.env.example)。

## 协作开发

`develop` 用于集成开发，各成员从该分支创建功能分支，通过 Pull Request 合入 `develop`。每次推送 `develop` 会自动构建并发布 `ghcr.io/yzmzx/luckyapi:develop`，同时发布 `sha-<完整提交 SHA>` 标签用于定位构建。联调部署可设置 `IMAGE_TAG=develop`，再拉取镜像并重启服务。正式版本继续通过 `vX.Y.Z` 标签发布。

```bash
git fetch origin
git switch --track origin/develop
git switch -c feature/your-feature
```

## 本地开发

```bash
npm install
npm run dev
```

提交前建议执行：

```bash
npm run check
npm test
npm run build
```

## 部署边界

- 当前版本为单管理员、单上游架构。
- 默认使用 SQLite，升级前请备份并验证数据可恢复。从含战队投注的旧版本升级时，首次启动会退还未结投注。永久额度退回余额，有效的限时额度按原有效期恢复，已到期的部分按原规则清退。历史结算与账单可供核对。
- 不包含多角色、多上游、Webhook 或外部告警系统。
- 保留现有请求体与响应体日志行为，生产部署时应严格控制日志访问权限。

## 安全说明

- 不要提交 `.env`、数据库、日志、备份、Cookie、证书或生产密钥。
- 首次启动前必须修改管理员密码。
- 已经公开过的密钥必须立即撤销并轮换，不能只删除 Git 历史。
- 安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告，不要发布包含利用细节的公开 Issue。

## 许可证

本仓库目前**未附带开源许可证**。公开可见不代表授予复制、修改、分发或商业使用许可。
