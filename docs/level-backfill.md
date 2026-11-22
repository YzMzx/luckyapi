# 用本站 SQLite 补算经验和首达铭牌

命令从一个本站 SQLite 快照读取业务记录和现有经验事件，用当前经验规则重放，输出用户经验变化和五个里程碑的席位变化。每个里程碑按历史累计经验首次达到门槛的时间取前三名。相同时间戳按用户 ID 升序决定先后。旧库不少字段虽然以毫秒存储，实际只精确到整秒，这种情况只能确定并列时间。

## 1. 选择输入库并备份

要上线结果，请使用**停服时的完整最新库**。结果是整库副本，其中账号、余额和业务流水都对应输入快照的时点。较早的备份可以用来试算，但把旧快照直接切到线上会丢失快照之后的业务。如果两份库都产生过新的业务记录，应先单独核对合并方案。如果曾经清理历史流水，请先找回完整记录；仅凭数据库现存的余额和部分流水，无法还原全部首达时间。

使用 Docker Compose 时先执行 `docker compose stop app`，停止其他写入进程。备份整个数据卷（包括数据库及同名 WAL/SHM 文件）和部署配置，保留原镜像版本。单独复制运行中数据库的主文件可能缺少已提交记录。命令使用 SQLite Backup API 取得一致快照，预览需要约一份整库大小的临时空间。

## 2. 在源码部署中预览和生成结果

在包含本命令的仓库版本和项目根目录执行。将示例路径换为实际文件。首次安装依赖可运行 `npm ci`。

```sh
npm run build
node dist/maintenance/level-backfill.js --db ./data/luckydraw.db > preview.json
```

先检查进程退出码和报告中的 `ready`。为 `true` 时，核对 `report.users` 中当前/补算后的经验、等级、佩戴选择，以及 `report.stages` 中各级前三席的用户 ID、事件键和时间戳。已有席位可能换人，仍有该级席位者保留佩戴选择，失去对应席位者恢复默认展示。报告包含用户标识，应保存在私有目录。

```sh
node dist/maintenance/level-backfill.js --db ./data/luckydraw.db --apply --output ./data/luckydraw.rebuilt.db > applied.json
node dist/maintenance/level-backfill.js --db ./data/luckydraw.rebuilt.db > verify.json
```

输出路径必须全新，父目录须存在并支持硬链接。结果是可独立启动的完整 SQLite 数据库。使用同一冻结输入时，预览和生成的 `report` 应一致。在结果库上再次预览时，新增或更新的事件、档案及席位写入计数应均为 0。

## 3. Docker Compose 部署

使用已经构建了本命令的镜像，源码部署可先运行 `docker compose build app`。在停服后运行一次性容器，路径为**容器内**路径。以下使用默认数据卷。

```sh
docker compose run --rm --no-deps -T app node dist/maintenance/level-backfill.js --db /app/data/luckydraw.db > preview.json
# 核对报告后生成新文件
docker compose run --rm --no-deps -T app node dist/maintenance/level-backfill.js --db /app/data/luckydraw.db --apply --output /app/data/luckydraw.rebuilt.db > applied.json
docker compose run --rm --no-deps -T app node dist/maintenance/level-backfill.js --db /app/data/luckydraw.rebuilt.db > verify.json
```

核对通过后，在现有 Compose 配置的 `services.app.environment` 中加入 `SQLITE_PATH: /app/data/luckydraw.rebuilt.db`，执行 `docker compose up -d --force-recreate app`。源码部署则将启动环境中的 `SQLITE_PATH` 指向结果文件的绝对路径。先限制外部写入，抽查后台等级、铭牌殿堂及余额，再开放业务。若需回退，在重新开放写入前停止服务，恢复原路径与原配置后重启。恢复开放后若已有新业务，回退前应先保存新库并核对该时段的流水。

## 计算口径与核对

- 每个用户每个业务日首签记 200 EXP。签到发放的 USD 另计收益经验。每 1 USD 可确认的净收入记 100 EXP，每 1 USD API Key 实扣记 10 EXP，跨笔累计不足 1 EXP 的部分。
- 以原业务事件键与现有经验对账，避免新旧记录重叠。保留可还原的独立经验事件。转账、借还本金、退款和失败的 API 调用均不产生新的收益或消费经验。
- 对于缺少关键明细或存在矛盾的记录，以报告中的具体原因为准。退出码 2 表示历史来源需要核对，检查 `warnings`；其他错误写入标准错误。修复或找回原始记录后重试，确认 `ready: true` 再切换。
