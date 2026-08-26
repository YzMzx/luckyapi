export const TEAM_BATTLE_MONEY_SCALE = 1_000_000;
export const TEAM_BATTLE_TAX_BASIS_POINTS = 1_000;
export const TEAM_BATTLE_MODES = ["1v1", "3v3", "5v5"] as const;
export type TeamBattleMode = typeof TEAM_BATTLE_MODES[number];
export type TeamBattleSide = "A" | "B";

export const TEAM_BATTLE_SEATS: Record<TeamBattleMode, number> = { "1v1": 1, "3v3": 3, "5v5": 5 };

export function teamBattleDollarsToUnits(amount: number) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("invalid team battle amount");
  const units = Math.round(amount * TEAM_BATTLE_MONEY_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs(amount * TEAM_BATTLE_MONEY_SCALE - units) > 1e-6)
    throw new Error("amount must have at most six decimal places");
  return units;
}

export function teamBattleUnitsToDollars(units: number) {
  if (!Number.isSafeInteger(units)) throw new Error("invalid team battle units");
  return units / TEAM_BATTLE_MONEY_SCALE;
}

export function teamBattleVoteThreshold(mode: TeamBattleMode) {
  const totalPlayers = TEAM_BATTLE_SEATS[mode] * 2;
  return Math.floor(totalPlayers / 2) + 1;
}

export function projectedReturnPpm(ownPoolUnits: number, opposingPoolUnits: number) {
  if (!Number.isSafeInteger(ownPoolUnits) || !Number.isSafeInteger(opposingPoolUnits) || ownPoolUnits <= 0 || opposingPoolUnits < 0) return null;
  const profitNumerator = BigInt(opposingPoolUnits) * BigInt(10_000 - TEAM_BATTLE_TAX_BASIS_POINTS) * 1_000_000n;
  return 1_000_000 + Number(profitNumerator / (BigInt(ownPoolUnits) * 10_000n));
}

type Weighted<K extends number> = { key: K; weight: number };

/** Largest-remainder allocation; ties are resolved by stable numeric key. */
export function allocateTeamBattleUnits<K extends number>(totalUnits: number, entries: readonly Weighted<K>[]) {
  if (!Number.isSafeInteger(totalUnits) || totalUnits < 0) throw new Error("invalid allocation total");
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) throw new Error("allocation requires positive weights");
  const rows = entries.map((entry) => {
    if (!Number.isSafeInteger(entry.weight) || entry.weight <= 0) throw new Error("invalid allocation weight");
    const numerator = BigInt(totalUnits) * BigInt(entry.weight);
    return { key: entry.key, units: Number(numerator / BigInt(totalWeight)), remainder: numerator % BigInt(totalWeight) };
  });
  let remaining = totalUnits - rows.reduce((sum, row) => sum + row.units, 0);
  rows.sort((left, right) => left.remainder === right.remainder ? left.key - right.key : left.remainder > right.remainder ? -1 : 1);
  for (const row of rows) {
    if (remaining <= 0) break;
    row.units += 1;
    remaining -= 1;
  }
  return new Map(rows.map((row) => [row.key, row.units]));
}

export type TeamBattleSettlementBet = { id: number; userId: number; team: TeamBattleSide; amountUnits: number };
export type TeamBattleSettlementPlayer = { id: number; userId: number; team: TeamBattleSide; seat: number };

export function calculateTeamBattleSettlement(
  bets: readonly TeamBattleSettlementBet[],
  players: readonly TeamBattleSettlementPlayer[],
  winnerTeam: TeamBattleSide,
) {
  const poolAUnits = bets.filter((bet) => bet.team === "A").reduce((sum, bet) => sum + bet.amountUnits, 0);
  const poolBUnits = bets.filter((bet) => bet.team === "B").reduce((sum, bet) => sum + bet.amountUnits, 0);
  if (poolAUnits <= 0 || poolBUnits <= 0) throw new Error("both team pools must be positive");
  const winningPoolUnits = winnerTeam === "A" ? poolAUnits : poolBUnits;
  const losingPoolUnits = winnerTeam === "A" ? poolBUnits : poolAUnits;
  const taxUnits = Number((BigInt(losingPoolUnits) * BigInt(TEAM_BATTLE_TAX_BASIS_POINTS)) / 10_000n);
  const playerTaxUnits = Math.floor(taxUnits / 2);
  const platformTaxUnits = taxUnits - playerTaxUnits;
  const losingPoolAfterTaxUnits = losingPoolUnits - taxUnits;
  const winningBets = bets.filter((bet) => bet.team === winnerTeam).sort((a, b) => a.id - b.id);
  const profitByBet = allocateTeamBattleUnits(losingPoolAfterTaxUnits, winningBets.map((bet) => ({ key: bet.id, weight: bet.amountUnits })));
  const payoutByBet = new Map<number, number>();
  for (const bet of bets) payoutByBet.set(bet.id, bet.team === winnerTeam ? bet.amountUnits + (profitByBet.get(bet.id) ?? 0) : 0);
  const orderedPlayers = [...players].sort((a, b) => a.team.localeCompare(b.team) || a.seat - b.seat || a.userId - b.userId);
  const taxShareByPlayer = orderedPlayers.length && playerTaxUnits > 0
    ? allocateTeamBattleUnits(playerTaxUnits, orderedPlayers.map((player) => ({ key: player.id, weight: 1 })))
    : new Map<number, number>();
  const payoutUnits = [...payoutByBet.values()].reduce((sum, units) => sum + units, 0);
  const distributedPlayerTaxUnits = [...taxShareByPlayer.values()].reduce((sum, units) => sum + units, 0);
  if (payoutUnits + distributedPlayerTaxUnits + platformTaxUnits !== poolAUnits + poolBUnits)
    throw new Error("team battle settlement is not conserved");
  return {
    winnerTeam,
    poolAUnits,
    poolBUnits,
    winningPoolUnits,
    losingPoolUnits,
    taxUnits,
    playerTaxUnits,
    platformTaxUnits,
    losingPoolAfterTaxUnits,
    payoutByBet,
    taxShareByPlayer,
  };
}
