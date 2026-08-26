# LuckyAPI

LuckyAPI 是一个面向 Linux.do 社区用户的自托管 API 运营平台，集成 OpenAI 兼容接口、额度与账务、社区娱乐玩法、分类榜单及管理后台。项目采用 React、TypeScript、Hono、tRPC、Drizzle ORM 和 SQLite，支持 Docker 单机部署。

## 主要功能

- Linux.do Connect OAuth 登录与账户合并
- OpenAI 兼容 API 网关、API Key、模型定价、分组和额度管理
- 请求日志、Token、扣费、成功率、延迟与 TTFT 监控
- 转账、借贷、手续费、额度限制和规则快照
- 签到、抽奖、视频红包、老虎机、举报、决斗和战队玩法
- 综合、API、金融和娱乐分类榜单
- 单管理员运营后台、模块开关、用户策略和操作审计
- 后台深色/浅色主题及桌面、移动端响应式布局

当前版本保持单管理员、单上游架构，数据库默认使用 SQLite。

## 快速开始

### Docker Compose

1. 复制环境变量模板：

   ```bash
   cp .env.example .env
   ```

2. 修改 `.env`，至少设置一个高强度 `ADMIN_PASSWORD`。如需 Linux.do 登录，再填写 OAuth Client ID、Client Secret 和站点 Origin。

3. 构建并启动：

   ```bash
   docker compose up -d --build
   ```

4. 打开 `http://localhost:3000`，管理后台地址为 `/admin`。

SQLite 数据保存在 Docker 卷 `luckydraw-data` 中。生产部署时请使用 HTTPS 反向代理，并正确转发 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。

### 本地开发

```bash
npm install
npm run dev
```

常用检查命令：

```bash
npm run check
npm test
npm run build
```

## OAuth 配置

在 Linux.do Connect 创建应用，将回调地址设置为：

```text
https://你的域名/api/oauth/callback
```

然后在 `.env` 或管理后台的“系统安全 / OAuth 与管理员安全”中填写配置。不要提交真实 Client Secret。

## 安全提示

- 不要提交 `.env`、数据库、日志、备份、Cookie、证书或生产密钥。
- 首次启动前必须修改管理员密码。
- 公开过的任何密钥都应立即撤销并轮换，不能只从 Git 历史中删除。
- 生产环境应定期备份 SQLite 数据卷，并在升级前验证备份可恢复。

安全问题请按 [SECURITY.md](SECURITY.md) 中的方式私下报告。

## 许可证

本仓库目前未附带开源许可证。公开可见不代表授予复制、修改、分发或商业使用许可。
