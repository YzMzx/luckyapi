import { readFile, stat } from "node:fs/promises";
import { verifySevenPickBundle } from "../seven-pick/verify";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const [, , file, flag, receiptId, ...rest] = process.argv;
if (!file || rest.length || (flag !== undefined && (flag !== "--receipt" || !receiptId))) {
  console.error("Usage: node seven-pick-verify.mjs <proof.json> [--receipt <32 lowercase hex characters>]");
  process.exitCode = 1;
} else {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_BUNDLE_BYTES) throw new Error("Expected an ordinary proof file up to 32 MiB");
    const raw = await readFile(file);
    if (raw.length > MAX_BUNDLE_BYTES) throw new Error("Proof file exceeds 32 MiB");
    const verified = verifySevenPickBundle(JSON.parse(raw.toString("utf8")) as unknown, receiptId);
    console.log(JSON.stringify(verified, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
