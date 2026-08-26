export type ModelForm = {
  id?: number;
  /** 创建时支持逗号/换行分隔批量添加 */
  name: string;
  upstreamId: string;
  upstreamModel: string;
  apiType: "chat" | "responses" | "claude" | "gemini";
  priceInput: string;
  priceOutput: string;
  priceCacheWrite: string;
  priceCacheRead: string;
  /** 勾选的分组名；空数组 = 全部分组可用 */
  groupSel: string[];
  enabled: boolean;
};
export type UpstreamForm = { id?: number; name: string; baseUrl: string; apiKey: string; enabled: boolean; timeoutMs: string };
export const emptyUpstream: UpstreamForm = { name: "", baseUrl: "", apiKey: "", enabled: true, timeoutMs: "60000" };

/** 留空 → null（不计费） */
export const pn = (s: string): number | null => (s.trim() === "" ? null : Number(s));
/** null → 留空显示 */
export const ps = (v: number | null): string => (v === null ? "" : String(v));
export const pf = (v: number | null): string => (v === null ? "—" : `$${v}`);

export function modelPayload(f: ModelForm) {
  return {
    id: f.id, name: f.name, upstreamId: Number(f.upstreamId),
    upstreamModel: f.upstreamModel, apiType: f.apiType,
    priceInput: pn(f.priceInput), priceOutput: pn(f.priceOutput),
    priceCacheWrite: pn(f.priceCacheWrite), priceCacheRead: pn(f.priceCacheRead),
    allowedGroups: f.groupSel.join(","),
    enabled: f.enabled,
  };
}
