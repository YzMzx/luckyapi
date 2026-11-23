import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { getDb } from "../queries/connection";
import { getSevenPickPublicProof } from "../seven-pick/lifecycle";
import { getSevenPickSealTimestamp } from "../seven-pick/seal-timestamp";

export const sevenPickProofApp = new Hono();

sevenPickProofApp.get("/verify.mjs", async (c) => {
  try {
    const script = await readFile(new URL("./maintenance/seven-pick-verify.js", import.meta.url), "utf8");
    return c.text(script, 200, {
      "Content-Disposition": 'attachment; filename="seven-pick-verify.mjs"',
      "X-Content-Type-Options": "nosniff",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "验证工具需要随生产构建发布" }, 404);
    throw error;
  }
});

sevenPickProofApp.get("/rounds/:roundId/proof", (c) => {
  const rawId = c.req.param("roundId");
  const roundId = Number(rawId);
  if (!/^[1-9][0-9]*$/.test(rawId) || !Number.isSafeInteger(roundId)) {
    return c.json({ error: "无效场次编号" }, 400);
  }
  const db = getDb().$client;
  const proof = getSevenPickPublicProof(db, roundId);
  if (!proof) return c.json({ error: "该场次尚无公开验证包" }, 404);
  c.header("Content-Disposition", 'attachment; filename="seven-pick-' + roundId + '.json"');
  c.header("X-Content-Type-Options", "nosniff");
  const timestamp = getSevenPickSealTimestamp(db, roundId);
  return c.json({ ...proof, ...(timestamp ? { timestamp } : {}) });
});
