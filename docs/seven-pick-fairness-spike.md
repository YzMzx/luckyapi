# 32选7公平开奖可行性验证

**结论：Quicknet 可以独立验证；OTS 尚未满足上线门槛。** 这里只记录分离实验，不代表生产已接入签名验证、OTS 或独立完整验证脚本。所有实验时间均为 UTC（北京时间 +8 小时）。

## Quicknet：实际 API 和 BLS 验证

- [drand 接入文档](https://docs.drand.love/developer/)；[drand v2 Quicknet info](https://api.drand.sh/v2/beacons/quicknet/info) 与 [Cloudflare v1 Quicknet info](https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info) 返回相同的参数：网络 `quicknet`、周期 3 秒、创世时刻 1692803367（Unix 秒）、方案 `bls-unchained-g1-rfc9380`、链哈希 `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`。独立按 [drand chain.Info.Hash](https://github.com/drand/drand/blob/v2.1.5/common/chain/info.go) 的顺序重算，得到相同链哈希；方案不在链哈希中，需另行锁定。
- [drand v2 第 1 轮](https://api2.drand.sh/v2/beacons/quicknet/rounds/1) 只有 `round` 与 `signature`；[Cloudflare v1 第 1 轮](https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1) 还携带 `randomness`。签名相同：`b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b`。对原始签名字节（不是 hex 文本）取 SHA-256 得 `1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a`，与 v1 响应一致。
- 在临时且已清理的目录中，按 npm SHA-512 完整性值校验并使用 [@noble/curves 2.4.0](https://registry.npmjs.org/@noble%2fcurves/2.4.0) 和 [@noble/hashes 2.4.0](https://registry.npmjs.org/@noble%2fhashes/2.4.0) 的正式包。按 [drand 验签规范实现](https://github.com/drand/drand/blob/v2.1.5/crypto/schemes.go) 使用 `bls12_381.shortSignatures`：对 `uint64be(round)` 取 SHA-256，再用 DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` 哈希到 G1，最后以锁定的 G2 公钥验证 G1 签名。第 1 轮与本次窗口的第 34207416 轮均验证为真；修改轮次、签名或公钥，均被拒绝。不使用 HTTP 的成功状态或其 `randomness` 作为验签替代。
- 生产依赖安装未完成：本地 sandbox 阻止 npm 缓存写入，且依赖未接入清单/锁文件。后续需正式锁定库和版本，确保运行时 Node ≥20.19，验证响应轮次与锁定轮次完全一致，核对链参数与 scheme，严格校验签名长度/编码，并从已验证签名推导随机数。未知网络、无效签名和站点故障一律不能触发 fallback 或替代开奖。

## OTS：10 分钟窗口实测

合成摘要（非玩家数据）`64bdc3b522b2aed8ebacef08b7a2f1732185d6ffc0485a30a473cd1b769de0ba`，于 2026-11-23 09:10:11.139 开始提交；在该轮出现前查询了固定 Quicknet 轮 34207416（计划时刻 09:20:12.000，约为提交后 10 分钟）。这只是观察窗口的外网测试，不是开盘前承诺或真实结算的演练。

| 观察时间 (UTC) | 端点与结果 |
|---|---|
| 09:10:13（服务端 Date） | [Alice](https://alice.btc.calendar.opentimestamps.org/) 与 [Bob](https://bob.btc.calendar.opentimestamps.org/) 的 `POST /digest` 都返回 HTTP 200，二进制响应分别 277、205 字节。按操作路径解析，两者各只有 `PendingAttestation`（标签 `83dfe30d2ef90c8e`），不是 Bitcoin 证明。 |
| 09:13:21 | 执行各自 pending 路径后查询同一 calendar tip：Alice、Bob 均 HTTP 404 `Pending confirmation in Bitcoin blockchain`。 |
| 09:15:51 | 固定轮次的 drand v2 返回 HTTP 425 `Requested future beacon`，Cloudflare v1 返回 HTTP 404。此类状态不构成未发布证明。 |
| 09:20:12.926 / 09:20:13.171 | 达到 10 分钟窗口：Alice / Bob 仍均 HTTP 404 `Pending confirmation in Bitcoin blockchain`。 |
| 09:20:14.896 / 09:20:15.063 | [Cloudflare v1](https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/34207416) / [drand v2](https://api.drand.sh/v2/beacons/quicknet/rounds/34207416) 均 HTTP 200，同轮、同签名；从签名计算的 SHA-256 为 `e0132ee3472022fb78192824d84948fa794d2e3653c9e398ccd5893cbcb08c22`，与 v1 的 `randomness` 相同。这是客户端观察时间，不是随机数的首次公开时刻。 |

Calendar commitment 查询：[Alice tip](https://alice.btc.calendar.opentimestamps.org/timestamp/6b0402f59551a6a428a603d7681e23c55e5a755ec8ea4d039ad33afa836e78e20a996d7129b3ea753e693fe1)；[Bob tip](https://bob.btc.calendar.opentimestamps.org/timestamp/6b0402f565047630d5aa55e152d332ba977d0dcd9cde517b7feda0f2c4391be136f206d94ed77f20ce8e76e5)。可继续尝试升级，但后续拿到 Bitcoin 证明不代表截止之前的存在已被独立证明。本次未持有合格的 OTS 证明，不能推论日后是否会取得合格证据，也不能推论所有场次都无法及时打包。

[OpenTimestamps 官方客户端](https://github.com/opentimestamps/opentimestamps-client) 说明公共日历会批处理，通常需要数小时才能上链。[OTS 证明代码](https://github.com/opentimestamps/python-opentimestamps/blob/master/opentimestamps/core/notary.py) 的 Bitcoin attestation 核对区块 Merkle root 并返回区块头 `nTime`。[Bitcoin 区块头文档](https://developer.bitcoin.org/reference/block_chain.html) 说明这是矿工填报的时间，并受前 11 块中位时间和节点的未来时间限制，不是可信的秒级出块实测时钟。只比较原始 `nTime` 与预定 Quicknet 时刻不足以严格判定先后；本机观察时间、HTTP Date、calendar 回执和 API 到达时间也不是独立时序证明。

保持原固定轮与原计划；未取得合格证据保持 `ots_waiting`，不发布为已结算。逾期、证据过晚或证据不足按规格走人工核查，不可把失败请求当作 Quicknet 未发布的证明，也不可直接放行或自动归因为未发布。上线前须用真实端到端测试验证能独立证明冻结摘要严格早于固定轮公开；否则阻断上线，不改变随机源、轮次或时间表。

## 本次仓库变更与本地验证

- [draw.ts](../api/seven-pick/draw.ts)：版本 `sha256-fy32-v1`；按数值排序的 32 个物品 ID，以域分离 SHA-256 扩展、拒绝采样和部分 Fisher–Yates 得到 7 个无重复 ID。使用上面的第 1 轮随机数，输入物品 ID 1–32 时结果为 `[1,6,15,22,29,30,32]`。
- [proof.ts](../api/seven-pick/proof.ts)：稳定排序的匿名记录 UTF-8 JSON 和 SHA-256 摘要，无时间声明。只公开场次、快照物品 ID 和每组的随机回执 ID、选项、金额；不公开用户 ID、内部订单 ID 或下注时间。摘要不证明开奖轮次和配置已在开盘前公开；不可变的开盘前场次快照仍须单独保留并公开。
- [drand.ts](../api/seven-pick/drand.ts)：Quicknet 链参数与固定轮次计算；没有生产 fetch 或 BLS 验证器。
- [fairness.test.ts](../api/seven-pick/fairness.test.ts)：9 个测试用例；隔离 strict TypeScript 检查通过，另用独立 Python 计算预期向量，并运行 10 条原生 Node 断言验证纯逻辑。默认 Vitest 启动受本地 sandbox 的 `spawn EPERM` 限制；改为在 Vitest 进程内转换 TypeScript 后，该文件 9 个测试全部通过。
