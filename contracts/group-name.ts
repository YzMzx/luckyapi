import { z } from "zod";

// eslint-disable-next-line no-control-regex -- 群内名称必须显式拒绝 C0/C1 控制字符。
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff<>]/u;
const RESERVED_NAMES = new Set([
  "管理员", "官方", "客服", "系统", "admin", "administrator", "system", "moderator", "root", "lucky",
]);

export function normalizeGroupName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * 群内名称是榜单和举报记录里的公开身份：必填、唯一，允许中英文/数字/常见标点，
 * 但拒绝控制字符、双向文本控制、HTML 尖括号和系统身份冒充。
 */
export const groupNameSchema = z.string()
  .superRefine((raw, ctx) => {
    if (FORBIDDEN_CHARS.test(raw)) {
      ctx.addIssue({ code: "custom", message: "群内名称不能包含控制字符或 < >" });
    }
  })
  .transform(normalizeGroupName)
  .superRefine((value, ctx) => {
    const length = [...value].length;
    if (length < 1) ctx.addIssue({ code: "custom", message: "请填写群内名称" });
    if (length > 32) ctx.addIssue({ code: "custom", message: "群内名称最多 32 个字符" });
    if (length > 0 && !/[\p{L}\p{N}]/u.test(value)) {
      ctx.addIssue({ code: "custom", message: "群内名称至少要包含一个中文、字母或数字" });
    }
    const reservedKey = value.toLowerCase().replace(/[\s._·-]+/gu, "");
    if (RESERVED_NAMES.has(reservedKey)) {
      ctx.addIssue({ code: "custom", message: "该名称为系统保留名称，请换一个" });
    }
  });
