import { describe, expect, it } from "vitest";
import {
  calculateTeamBattleSettlement,
  projectedReturnPpm,
  teamBattleVoteThreshold,
} from "./team-battle";

describe("team battle settlement contract", () => {
  it("uses documented thresholds, dynamic odds and conserves every integer unit", () => {
    expect([teamBattleVoteThreshold("1v1"), teamBattleVoteThreshold("3v3"), teamBattleVoteThreshold("5v5")]).toEqual([2, 4, 6]);
    expect(projectedReturnPpm(3_000_000, 10_000_000)).toBe(4_000_000);
    expect(projectedReturnPpm(0, 10_000_000)).toBeNull();
    const result = calculateTeamBattleSettlement([
      { id: 1, userId: 11, team: "A", amountUnits: 1_000_000 },
      { id: 2, userId: 11, team: "A", amountUnits: 2_000_000 },
      { id: 3, userId: 12, team: "B", amountUnits: 10_000_001 },
    ], [
      { id: 1, userId: 1, team: "A", seat: 1 },
      { id: 2, userId: 2, team: "B", seat: 1 },
    ], "A");
    expect(result.taxUnits).toBe(1_000_000);
    expect(result.playerTaxUnits).toBe(500_000);
    expect(result.platformTaxUnits).toBe(500_000);
    expect([...result.payoutByBet.values()].reduce((sum, units) => sum + units, 0)
      + [...result.taxShareByPlayer.values()].reduce((sum, units) => sum + units, 0)
      + result.platformTaxUnits).toBe(result.poolAUnits + result.poolBUnits);
  });
});
