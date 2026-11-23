import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { quicknetRoundTimeMs } from "./drand";
import { setSevenPickRuntime } from "./release";
import { ensureSevenPickTimestampSchema, getSevenPickSealTimestamp, refreshSevenPickSealTimestamps } from "./seal-timestamp";
import { requestSevenPickTsaStamp, SEVEN_PICK_TSA, verifySevenPickTsaStamp, type TsaStampEvidence } from "./tsa";

vi.mock("./tsa", async (importOriginal) => ({
  ...await importOriginal<typeof import("./tsa")>(),
  requestSevenPickTsaStamp: vi.fn(),
  verifySevenPickTsaStamp: vi.fn(),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("reads the persisted RFC3161 switch and does not record proof after disabling it", async () => {
  const db = new Database(":memory:");
  try {
    vi.stubEnv("SEVEN_PICK_RFC3161", "1");
    const quicknetRound = 1001;
    const scheduled = quicknetRoundTimeMs(quicknetRound);
    let now = scheduled - 90_000;
    const options = { now: () => now };
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE admin_logs (action TEXT, detail TEXT);
      CREATE TABLE seven_pick_rounds (id INTEGER PRIMARY KEY, quicknet_round INTEGER, quicknet_scheduled_at INTEGER, status TEXT);
      CREATE TABLE seven_pick_seals (round_id INTEGER PRIMARY KEY, commitment_hex TEXT, sealed_at INTEGER);
      CREATE TABLE seven_pick_quicknet_seals (round_id INTEGER PRIMARY KEY);
      INSERT INTO seven_pick_quicknet_seals VALUES (1);
    `);
    db.prepare("INSERT INTO seven_pick_rounds VALUES (1,?,?,'sealed')").run(quicknetRound, scheduled);
    db.prepare("INSERT INTO seven_pick_seals VALUES (1,?,?)").run("4a".repeat(32), now);
    ensureSevenPickTimestampSchema(db);
    const evidence: TsaStampEvidence = {
      provider: SEVEN_PICK_TSA.provider, url: SEVEN_PICK_TSA.url, method: "POST", requestedAt: now, receivedAt: now + 1,
      statusCode: 200, responseDate: null, bodyHex: "aa", error: null,
      nonceHex: "4a".repeat(8), requestHex: "aa", rootCrlHex: null, issuerCrlHex: null,
    };
    vi.mocked(verifySevenPickTsaStamp).mockReturnValue({
      genTimeMs: now, accuracyMs: 500, upperBoundMs: now + 500,
      signerFingerprint: "a".repeat(64), policy: SEVEN_PICK_TSA.policy,
    });
    await refreshSevenPickSealTimestamps(db, options);
    expect(requestSevenPickTsaStamp).not.toHaveBeenCalled();

    vi.stubEnv("SEVEN_PICK_RFC3161", "0");
    setSevenPickRuntime(db, "rfc3161Enabled", true, 1);
    vi.mocked(requestSevenPickTsaStamp).mockImplementationOnce(async () => {
      setSevenPickRuntime(db, "rfc3161Enabled", false, 1);
      return evidence;
    });
    await refreshSevenPickSealTimestamps(db, options);
    expect(requestSevenPickTsaStamp).toHaveBeenCalledOnce();
    expect(getSevenPickSealTimestamp(db, 1)).toBeNull();
    await refreshSevenPickSealTimestamps(db, options);
    expect(requestSevenPickTsaStamp).toHaveBeenCalledOnce();

    setSevenPickRuntime(db, "rfc3161Enabled", true, 1);
    now += 31_000;
    vi.mocked(requestSevenPickTsaStamp).mockResolvedValueOnce(evidence);
    await refreshSevenPickSealTimestamps(db, options);
    expect(requestSevenPickTsaStamp).toHaveBeenCalledTimes(2);
    expect(getSevenPickSealTimestamp(db, 1)).toEqual(evidence);
    setSevenPickRuntime(db, "rfc3161Enabled", false, 1);
    expect(getSevenPickSealTimestamp(db, 1)).toEqual(evidence);
  } finally {
    db.close();
  }
});
