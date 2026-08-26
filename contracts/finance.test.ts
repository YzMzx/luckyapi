import { describe, expect, it } from "vitest";
import { accruedInterestUnits, allocateLoanCollection, interestTaxUnits, MONTH_MS, transferFeeUnits, unitsFromMoney } from "./finance";

describe("transfer and peer-loan accounting", () => {
  it("charges sender a separately rounded-up 3% transfer fee", () => {
    expect(transferFeeUnits(unitsFromMoney(100))).toBe(3_000_000);
    expect(transferFeeUnits(1)).toBe(1);
  });

  it("prorates monthly interest by actual elapsed time on a 30-day basis", () => {
    expect(accruedInterestUnits({ principalUnits: unitsFromMoney(100), monthlyRateBasisPoints: 300, acceptedAtMs: 0, settlementAtMs: MONTH_MS / 2, dueAtMs: MONTH_MS * 2 })).toBe(unitsFromMoney(1.5));
    expect(accruedInterestUnits({ principalUnits: unitsFromMoney(100), monthlyRateBasisPoints: 300, acceptedAtMs: 0, settlementAtMs: MONTH_MS * 3, dueAtMs: MONTH_MS * 2 })).toBe(unitsFromMoney(6));
  });

  it("taxes only collected interest at 10% and conserves every unit", () => {
    const allocation = allocateLoanCollection({ availableUnits: unitsFromMoney(35), outstandingPrincipalUnits: unitsFromMoney(30), outstandingInterestUnits: unitsFromMoney(10) });
    expect(allocation).toMatchObject({ principalUnits: unitsFromMoney(30), interestUnits: unitsFromMoney(5), taxUnits: unitsFromMoney(.5), lenderCreditUnits: unitsFromMoney(34.5), remainingInterestUnits: unitsFromMoney(5) });
    expect(allocation.lenderCreditUnits + allocation.taxUnits).toBe(allocation.collectedUnits);
    expect(interestTaxUnits(unitsFromMoney(10))).toBe(unitsFromMoney(1));
  });
});
