# 七星寻宝运行手册

## 开放和暂停

使用 Node.js 20.19+；运行 `npm ci`、`npm run build`，再按项目部署说明运行生产服务。开发服务器 `npm run dev` 用于预览，不负责生产调度。

- 玩家入口是 `/entertainment/seven-pick`；配置入口是 `/admin/entertainment/seven-pick`，复用现有管理员登录。
- `.env` 设置 `SEVEN_PICK_ENABLED=1`，并在后台启用已生效的七星寻宝配置，才会接收投注。两项缺一不可；生产开关默认为 `0`。配置按北京时间次日生效；默认北京时间 13:00–21:00 每整点一场，开场后 10 分钟封盘、20 分钟计划开奖。
- Docker Compose 更改 `.env` 后运行 `docker compose up -d`，而非只 `restart`。部署健康状态不代表当前可投注，开盘还取决于有效后台配置、当日场次和风控。设置 `SEVEN_PICK_ENABLED=0` 可停止接收新的投注，不应中断既有场次的封盘、结算或退款。
- 可另设 `SEVEN_PICK_RFC3161=1` 启用封盘时间凭证，默认 `0`。只向公开 Microsoft 服务提交摘要，不需要账户、API 密钥、钱包或额外链上手续。服务故障、凭证缺失、验签失败或来得太晚均不阻塞派奖。

## 开奖、对账和复核

- 开盘前按计划开奖时间绑定唯一的 drand Quicknet 轮次。两家中继只用于读取同一轮；验证器使用固定的 Quicknet 公钥核验 BLS 签名，不把中继返回的随机数字段或 HTTP 成功状态当作信任依据。
- 封盘保存匿名投注清单和 SHA-256 承诺。到原定时间获取同轮有效签名后，从签名的原始字节派生随机数，用固定的 `sha256-fy32-v1` 洗牌从 32 个场次物品 ID 中抽取 7 个。签名暂不可用时等待和重试同一轮，不提前开奖、切换轮次或使用替代随机源。
- 投注以千分之一 USDT 记账，支持整单幂等、同场组合去重、五组限制。风控使用全站可用模拟现金的 20%，要求对所有可能结果精确计算最坏赔付。
- 图片支持 JPEG、PNG、WebP，并在服务器解码重编码后保存。图片默认持久化到 `data/seven-pick-images`，可用 `SEVEN_PICK_IMAGES_DIR` 指定目录；容器内建议放在数据卷。

已结算场次提供 JSON 和独立 Node.js 验证工具。离线重算 Quicknet 签名、开奖号码、匿名清单摘要和赔付；用 `--receipt` 查看个人回执的命中数和返还金额，回执不传给外部服务。

```sh
node seven-pick-verify.mjs seven-pick-123.json
npm run seven-pick:verify -- seven-pick-123.json --receipt "0123456789abcdef0123456789abcdef"
```

**证明边界：** Quicknet 签名可以独立确认随机输入，固定轮次、物品快照和算法可以复算唯一结果。仅有匿名清单和其哈希不会独立证明清单何时冻结、是否完整；没有可信时间凭证时，不应声称已独立验证封盘先于开奖。可选 RFC 3161 对场次编号、Quicknet 轮次与预定时间、记录的封盘时间以及匿名清单承诺的规范化摘要签名。通过核验且签名时间上界早于固定轮次的凭证，与开奖复算结论分别报告；不用于生成随机数，不是开奖或派奖条件。详见 [RFC 3161 时间凭证](./seven-pick-tsa.md)。

## 本地演练

```sh
npm ci
npm run build
npm run seven-pick:drill
```

演练使用隔离的 SQLite 内存数据库与固定的历史 Quicknet 数据；不会访问生产钱包，也不会对外发布演练结果。
