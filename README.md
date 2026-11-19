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
  <img alt="version" src="https://img.shields.io/badge/version-v1.0.7-8b5e16" />
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

应用环境变量示例见 [`.env.example`](.env.example)。

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
