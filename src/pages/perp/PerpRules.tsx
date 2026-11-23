import { useId, useRef } from "react";
import { EXP_PER_USD } from "@contracts/levels";
import {
  DEFAULT_PERP_KLINE_INTERVAL,
  PERP_KLINE_INTERVALS,
} from "@contracts/perp-kline";
import { button, sim, type PerpApi } from "./format";
import "./PerpRules.css";

type Config = PerpApi["account"]["config"];
const heading = "mb-2 text-base font-bold text-foreground";
const list = "list-disc space-y-1 pl-5";

export function PerpRules({ config }: { config?: Config }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const feeRate = config && config.redemptionFeeBps / 100;
  return (
    <>
      <span className="mt-2 flex flex-wrap items-baseline gap-x-1 text-sm text-muted-foreground">
        <span>Bybit 公开行情 · 24 小时模拟交易 · 逐仓保证金</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          aria-haspopup="dialog"
          className="font-semibold text-[#ffce68] underline underline-offset-4 hover:text-[#ffe2a5]"
          onClick={() => dialog.current?.showModal()}
        >
          规则
        </button>
      </span>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="perp-rules-dialog m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-border bg-[#101d2b] p-0 text-foreground"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-[#101d2b] px-5 py-4">
          <h2 id={titleId} className="text-xl font-bold">
            模拟合约规则
          </h2>
          <form method="dialog">
            <button type="submit" className={button}>
              关闭
            </button>
          </form>
        </div>
        <div className="space-y-5 px-5 py-4 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h3 className={heading}>交易与委托</h3>
            <ul className={list}>
              <li>
                行情来自 Bybit 公开接口，开仓、平仓和强平都只在本站模拟，不向
                Bybit 发单。
              </li>
              <li>
                K 线默认 {DEFAULT_PERP_KLINE_INTERVAL} 分钟，可切换{" "}
                {PERP_KLINE_INTERVALS.join("、")} 分钟。图表 K
                线仅用于看图，不作为普通委托的成交价。
              </li>
              <li>
                市价单用受理后的新鲜订单簿逐档成交。市价开仓在滑点范围内不足全额时拒单，手动市价平仓可部分成交。同一份快照中已成交的深度不会重复使用。
              </li>
              <li>
                限价单只使用符合限价的深度，数量不足就继续等待。条件单由标记价格达到指定触发价时触发，之后按所选单型检查深度。
              </li>
              <li>
                后台每 5
                秒检查挂单和强平，可能错过两次检查之间的短暂触价。挂单不预冻结资金或仓位，成交时重新校验；未成交可在「我的委托」撤销。
              </li>
            </ul>
          </section>
          <section>
            <h3 className={heading}>逐仓、手续费和强平</h3>
            <ul className={list}>
              <li>
                同一合约只能持有一个方向，改变方向或杠杆前需先平仓。从「逐仓持仓」对应行可部分或全部平仓。
              </li>
              <li>
                {config ? (
                  <>
                    站内杠杆范围：{config.minLeverage}×–{config.maxLeverage}
                    ×，仅限整数倍；开平仓手续费按成交名义价值的{" "}
                    {config.takerFeeBps / 100}% 计。
                  </>
                ) : (
                  "杠杆范围和开平仓手续费以交易表单的当前规则为准。"
                )}
              </li>
              <li>
                开仓和加仓的杠杆上限取站内上限与 Bybit
                合约上限中较低者；若合约上限低于站内下限，则不能开仓或加仓。调整范围不会改变已有持仓的杠杆，超出范围的持仓仍可平仓，但不能加仓。
              </li>
              <li>
                持仓跨过资金费结算时点，按该品种的费率收付；正费率多仓支付、空仓收取，负费率相反。
              </li>
              <li>
                逐仓权益低于或等于维持保证金要求时会触发强平。
                {config && (
                  <>维持保证金率为 {config.maintenanceMarginBps / 100}%。</>
                )}
                强平判断看标记价格；触发后锁定仓位，等到新鲜深度足以全额成交再执行。K
                线上的预估强平线不代表成交价。亏损最多耗尽该仓位的保证金，不扣其他仓位或钱包资金。
              </li>
              <li>
                在逐仓持仓可手动追加保证金，只从可用模拟金转入，不改变数量、开仓均价或杠杆档位，也不收手续费。确认时若已触发强平，则不追加。
              </li>
              {config && (
                <li>
                  开仓名义价值上限：每位玩家 {sim(config.userLimitUnits)}
                  、全平台 {sim(config.platformLimitUnits)} 模拟
                  USDT。暂停开仓的品种仍能平仓。
                </li>
              )}
            </ul>
          </section>
          <section>
            <h3 className={heading}>余额兑换</h3>
            <ul className={list}>
              <li>
                只可用永久可用余额免费换入模拟金；只有可用模拟金可以兑回，持仓保证金不能直接兑回。
              </li>
              {config ? (
                <li>
                  当前比例：1 单位永久余额 ={" "}
                  {config.exchangeRate.toLocaleString("zh-CN")} 模拟金；
                  {feeRate === 0 ? (
                    "当前兑回免手续费。"
                  ) : (
                    <>兑回按总额收取 {feeRate}% 手续费，原额兑回也会收费。</>
                  )}
                </li>
              ) : (
                <li>当前兑换比例和兑回手续费请以「余额兑换」预览为准。</li>
              )}
              <li>
                同一比例双向使用。比例调整后，已有模拟金也按新比例兑回。确认前请核对本次手续费和实际到账金额。
              </li>
            </ul>
          </section>
          <section>
            <h3 className={heading}>经验怎么计算</h3>
            <p>
              <strong className="text-foreground">
                只对已兑回的净盈利发经验。
              </strong>{" "}
              扣除兑回手续费后，实际到账先抵扣尚未收回的本金，超出部分按每 1 USD
              = {EXP_PER_USD.income} EXP 计算。
            </p>
            <p className="mt-2">
              例如，尚有 10 USD 本金未收回，这次扣费后实际到账 12 USD：其中 10
              USD 是回本，2 USD 是净盈利，可获得 {2 * EXP_PER_USD.income} EXP。
            </p>
            <p className="mt-2">
              分批兑回会继续抵扣剩余本金。只回本、亏损、换入和未兑回的浮盈不计经验；不足
              1 EXP 的部分会累计。预览只显示预计经验，确认兑回后才实际发放。
            </p>
          </section>
          <section>
            <h3 className={heading}>周榜与持仓广场</h3>
            <p className="mb-2">
              实时盈亏榜按标记价计算，将每位玩家所有未平仓合约的浮动盈亏相加，不计已实现盈亏、手续费和资金费。缺少任一仓位的有效报价时，暂不参与排名。
            </p>
            <p>
              周榜按北京时间每周一 00:00 的账户权益结算，00:05
              起归档。计入行情盈亏、交易手续费和资金费，排除模拟金换入和兑回。跨周持仓按周界标记价格估值，行情不足时延后结算。
            </p>
            <p className="mt-2">
              持仓广场向已登录会员展示公开昵称和当前模拟持仓；「在线」表示最近
              90 秒内有合约页面在前台活动，不代表正在交易。
            </p>
          </section>
        </div>
      </dialog>
    </>
  );
}
