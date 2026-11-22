import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";

export type PerpApi = inferRouterOutputs<AppRouter>["perps"];
export const coin = (atoms: number) =>
  (atoms / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 8 });
export const rate = (e8: number) =>
  (e8 / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6 }) + "%";
export const baseCoin = (symbol: string) => symbol.replace(/USDT$/, "");
export const orderLabel = {
  openLong: "开多",
  openShort: "开空",
  close: "平仓",
  liquidate: "强平",
};
export const notionalUnits = (quantity: number, price: number) =>
  Number((BigInt(quantity) * BigInt(price)) / 100_000_000n);
export const panel =
  "min-w-0 rounded-2xl border border-border bg-[#101d2b] p-4 sm:p-6";
export const input =
  "mt-1 block w-full rounded-lg border border-border bg-[#162638] px-3 py-2 text-sm";
export const button =
  "rounded-lg border border-[#af915f]/60 px-3 py-2 text-sm font-semibold text-[#ffce68] hover:border-[#FFB700] disabled:cursor-not-allowed disabled:opacity-50";
export const sim = (units: number) =>
  (units / 1_000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
export const credit = (units: number) =>
  (units / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
export const signed = (units: number) => (units > 0 ? "+" : "") + sim(units);
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const day = (at: number) => dateFormat.format(at);
export const time = (at: number) => timeFormat.format(at);
const seconds = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export const stamp = (at: number) => day(at) + " " + seconds.format(at);
export function decimalUnits(raw: string, places: number) {
  if (!/^[0-9]+([.][0-9]+)?$/.test(raw)) return 0;
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > places) return 0;
  const value = Number(whole + fraction.padEnd(places, "0"));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
