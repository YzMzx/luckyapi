const ACCOUNT_ID_MAX_LENGTH = 32;

export function sanitizeAccountId(value: string) {
  return value.replace(/\D/g, "").slice(0, ACCOUNT_ID_MAX_LENGTH);
}

/** Normalize a decimal field and reject exponent notation at the UI boundary. */
export function sanitizeMoneyInput(value: string) {
  const cleaned = value.split(/[eE]/, 1)[0].replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  const rawWhole = (dot >= 0 ? cleaned.slice(0, dot) : cleaned).slice(0, 7);
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  if (dot < 0) return whole;
  const fraction = cleaned.slice(dot + 1).replace(/\./g, "").slice(0, 6);
  return `${whole}.${fraction}`;
}

export function transferInputProblem(accountId: string, amount: string) {
  if (!/^\d{1,32}$/.test(accountId)) return "请输入纯数字 Linux.do 账号 ID";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{0,6})?$/.test(amount)) return "金额最多保留 6 位小数";
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return "转移金额必须大于 0";
  if (value > 1_000_000) return "单次转移金额不能超过 1,000,000";
  return null;
}
