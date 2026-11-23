# 七星寻宝可选 RFC 3161 时间凭证

仅当管理员在「七星寻宝 → 运行开关」中启用 RFC 3161 时，服务才会在封盘后异步申请时间凭证，默认关闭。此功能不参与开奖或派奖。时间戳请求发送至 Microsoft 的公开 RFC 3161 端点。实测无需账户、API 密钥或付费。服务接受 SHA-256 摘要、随机 nonce 和显式策略 OID 1.3.6.1.4.1.601.10.3.1，签发的 TSTInfo 带有 500 毫秒的签名精度。 [Microsoft 集成文档](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)

CMS 信任固定的 Microsoft Identity Verification Root Certificate Authority 2020 和 Microsoft Public RSA Timestamping CA 2020。两张证书均从 Microsoft 证书库单独获得，DER SHA-256 指纹也与独立审计报告第 4 页一致。Microsoft 可能轮换实际为请求签名的叶证书，验证器要求其仅有关键的时间戳 EKU、仅允许数字签名的关键 Key Usage、有效签发链、CMS ESSCertIDv2 证书绑定、分属对应颁发者的两份签名 CRL，以及足够精确的签名时间范围。 [根证书](https://www.microsoft.com/pkiops/certs/Microsoft%20Identity%20Verification%20Root%20Certificate%20Authority%202020.crt) · [颁发者证书](https://www.microsoft.com/pkiops/certs/Microsoft%20Public%20RSA%20Timestamping%20CA%202020.crt) · [独立审计](https://www.microsoft.com/pkiops/docs/content/seals/Microsoft%20PKI%20ACS%20WTBR%20CS%20Independent%20Accountant%27s%20Opinion%20Report%20And%20Management%20Assertion_FY26_Final.pdf)

| 固定证书 | DER SHA-256 |
| --- | --- |
| Microsoft Identity Verification Root Certificate Authority 2020 | 5367f20c7ade0e2bca790915056d086b720c33c1fa2a2661acf787e3292e1270 |
| Microsoft Public RSA Timestamping CA 2020 | 36e731cfa9bfd69dafb643809f6dec500902f7197daeaad86ea0159a2268a2b8 |

消息印记是 UTF-8 JSON 数组 `["LuckyAPI/32pick7/quicknet-seal-tsa/v1", roundId, quicknetRound, quicknetScheduledAt, sealedAt, commitmentHex]` 的 SHA-256：时间均为 Unix 毫秒，序列化不加空格和换行。请求只发送摘要与协议必需的字段，不发送投注明细。凭证携带原始 DER 请求、原始 DER 签名响应和分别签发的根及颁发者 CRL。公开验证器可以离线匹配策略与 nonce，核对消息摘要与签名、证书链与适用的历史 CRL，并按签名精度计算保守的 UTC 上界。HTTP Date、本机观测时间和证书有效期不用于计算上界。归档的 CRL 只覆盖其中注明的时段，事后披露的密钥失陷仍应另行复核。 [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html) · [根 CRL](https://www.microsoft.com/pkiops/crl/Microsoft%20Identity%20Verification%20Root%20Certificate%20Authority%202020.crl) · [颁发者 CRL](https://www.microsoft.com/pkiops/crl/Microsoft%20Public%20RSA%20Timestamping%20CA%202020.crl)

通过核验且上界严格早于固定 Quicknet 轮次的凭证，会随公开证明下载；离线验证器独立报告结论。时间凭证缺失、网络故障或验签失败不会延迟开奖、阻止结算或产生另一个开奖结果。详见[运行手册](./seven-pick-development.md)。

## 实测

2026-11-23 北京时间 20:32，使用空单匿名清单跑通补充时间戳和固定 Quicknet 轮次。Microsoft 签名精度为 500 毫秒，保守时间上界 20:32:16.173；Quicknet 第 34211263 轮计划时刻 20:32:33.000，两者相差 16.827 秒。两家中继同轮返回有效签名，独立复算为 `[2, 6, 12, 16, 23, 24, 29]`。该测试不使用生产订单或钱包。
