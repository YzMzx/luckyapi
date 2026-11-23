import assert from "node:assert/strict";
import { env } from "node:process";
import Database from "better-sqlite3";
import { PERP_ENGINE_SCHEMA } from "../perp/schema";
import { PERP_WEEKLY_SCHEMA } from "../perp/weekly";
import { getSevenPickConfig, saveSevenPickConfig } from "../seven-pick/config";
import { verifyQuicknetBeacon } from "../seven-pick/drand";
import { deriveDraw } from "../seven-pick/draw";
import { createSevenPickRound, openSevenPickRound, placeSevenPickOrderForTest, listSevenPickOrders } from "../seven-pick/engine";
import { ensureSevenPickSchema } from "../seven-pick/schema";
import { ensureSevenPickLifecycleSchema } from "../seven-pick/lifecycle-schema";
import {
  approveSevenPickRefund, evaluateSevenPickRound, recordSevenPickQuicknetEvidence,
  getSevenPickLifecycle, getSevenPickPublicProof, sealSevenPickRound,
  resumeSevenPickRefund, settleSevenPickRound,
} from "../seven-pick/lifecycle";
import { readSevenPickCash } from "../seven-pick/wallet";
import { verifySevenPickBundle } from "../seven-pick/verify";

const opensAt = Date.parse("2026-11-23T09:00:00Z");
const oneHour = 3_600_000;
const walletStart = 500_000_000;
const beaconFixture = {
  round: 34207412,
  signature: "b5c4e515b26055f015d9fce7d32986956bd056276187a6f6aa7713ddb6e66c69a8a0da3a81b151bc11397e2f3d44b850",
};

// The command accepts no DB path and never imports the application DB singleton.
const db = new Database(":memory:");
try {
  env.NODE_ENV = "test";
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1)");
  db.exec(PERP_ENGINE_SCHEMA);
  db.exec(PERP_WEEKLY_SCHEMA);
  ensureSevenPickSchema(db);
  ensureSevenPickLifecycleSchema(db);
  db.prepare("INSERT INTO perp_wallets(user_id,cash_units) VALUES (1,?)").run(walletStart);
  const defaults = getSevenPickConfig(db, opensAt);
  saveSevenPickConfig(db, {
    enabled: true,
    openMinutes: [17 * 60, 18 * 60],
    closeAfterMinutes: defaults.closeAfterMinutes,
    drawAfterMinutes: defaults.drawAfterMinutes,
    minStakeUnits: defaults.minStakeUnits,
    maxStakeUnits: defaults.maxStakeUnits,
    multipliers: defaults.multipliers,
    items: defaults.items,
  }, opensAt - 24 * oneHour);

  const round = createSevenPickRound(db, opensAt, opensAt - 1000);
  assert.equal(openSevenPickRound(db, round.id, opensAt).status, "open");
  const beacon = verifyQuicknetBeacon(round.quicknetRound, beaconFixture);
  const itemIds = deriveDraw(round.items.map((item) => item.id), beacon.randomness);
  const input = { roundId: round.id, requestKey: "drill-settlement", bets: [{ itemIds, amount: "1.000" }] };
  assert.deepEqual(placeSevenPickOrderForTest(db, 1, input, opensAt + 1), placeSevenPickOrderForTest(db, 1, input, opensAt + 2));
  assert.equal(readSevenPickCash(db, 1), walletStart - 1000);
  sealSevenPickRound(db, round.id, round.closesAt);
  assert.equal(await settleSevenPickRound(db, round.id, round.quicknetScheduledAt), null);
  const drawTime = round.quicknetScheduledAt;
  recordSevenPickQuicknetEvidence(db, round.id, [{
    source: "drand-v2", round: beacon.round, verdict: "verified", method: "GET",
    url: "https://api.drand.sh/v2/beacons/quicknet/rounds/" + beacon.round,
    requestedAt: drawTime, receivedAt: drawTime, statusCode: 200, responseDate: null, error: null,
    bodyHex: Buffer.from(JSON.stringify(beaconFixture)).toString("hex"),
  }], drawTime);
  const result = await settleSevenPickRound(db, round.id, drawTime);
  assert(result);
  await settleSevenPickRound(db, round.id, drawTime + 1);
  assert.deepEqual(getSevenPickPublicProof(db, round.id)?.result, result);
  assert.equal(db.prepare("SELECT COUNT(*) FROM seven_pick_ledger WHERE round_id=? AND kind='payout'").pluck().get(round.id), 1);
  assert.equal(result.totalPayoutUnits, 50_000_000);
  assert.equal(readSevenPickCash(db, 1), walletStart - 1000 + result.totalPayoutUnits);
  const bundle = getSevenPickPublicProof(db, round.id);
  assert.deepEqual(verifySevenPickBundle(bundle).itemIds, itemIds);
  assert.equal(listSevenPickOrders(db, 1)[0].bets[0].payoutUnits, result.totalPayoutUnits);

  const refundStart = opensAt + oneHour;
  const refundRound = createSevenPickRound(db, refundStart, refundStart - 1000);
  const cashBeforeRefundRound = readSevenPickCash(db, 1);
  openSevenPickRound(db, refundRound.id, refundStart);
  placeSevenPickOrderForTest(db, 1, { roundId: refundRound.id, requestKey: "drill-refund", bets: [{ itemIds, amount: "1.001" }] }, refundStart + 1);
  const reviewAt = refundRound.quicknetScheduledAt + 1;
  sealSevenPickRound(db, refundRound.id, reviewAt);
  evaluateSevenPickRound(db, refundRound.id, reviewAt);
  assert.equal(getSevenPickLifecycle(db, refundRound.id)?.status, "review");
  const review = { roundId: refundRound.id, reason: "seal_missed" as const, reviewer: "isolated-drill", notes: "演练错过封盘" };
  await approveSevenPickRefund(db, review, reviewAt);
  assert.equal(resumeSevenPickRefund(db, refundRound.id, reviewAt + 1)?.status, "refunded");
  assert.equal(resumeSevenPickRefund(db, refundRound.id, reviewAt + 2)?.status, "refunded");
  assert.equal(readSevenPickCash(db, 1), cashBeforeRefundRound);
  assert.equal(listSevenPickOrders(db, 1)[0].bets[0].refundUnits, 1001);
  console.log(JSON.stringify({
    mode: "isolated-drill", database: ":memory:", settlement: "fixed-quicknet", timestampRequired: false,
    verifiedQuicknetRound: beacon.round, itemIds: result.itemIds, committedOrders: 2,
    payoutUnits: result.totalPayoutUnits, refundedUnits: 1001, finalCashUnits: readSevenPickCash(db, 1),
  }, null, 2));
} finally {
  db.close();
}
