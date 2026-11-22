import { describe, expect, it } from "vitest";
import {
  maxOrderQuantity,
  percentageQuantity,
  estimateOrder,
  type EstimateInput,
  estimateReferencePrice,
} from "./perp-estimate";
const coin = 100_000_000;
const config: EstimateInput = {
  action: "openLong",
  priceUnits: 100_000,
  leverage: 5,
  availableCashUnits: 100_000,
  qtyStepAtoms: 10_000,
  minQtyAtoms: 10_000,
  maxQtyAtoms: 10 * coin,
  minNotionalUnits: 1,
  takerFeeBps: 6,
  maintenanceMarginBps: 50,
};
const prev = {
  side: "long" as const,
  leverage: 5,
  quantityAtoms: coin,
  entryNotionalUnits: 100_000,
  marginUnits: 20_000,
};
describe("client order estimates in integer exchange units", () => {
  it("selects explicit reference prices for the four order types and both market sides", () => {
    const m = {
      action: "openLong",
      orderType: "market",
      bidUnits: 99800,
      askUnits: 100200,
      limitPriceUnits: 98000,
      triggerPriceUnits: 101000,
    } as const;
    expect(estimateReferencePrice(m)).toBe(100200);
    expect(estimateReferencePrice({ ...m, action: "openShort" })).toBe(99800);
    expect(
      estimateReferencePrice({ ...m, action: "close", positionSide: "short" })
    ).toBe(100200);
    expect(
      estimateReferencePrice({ ...m, action: "close", positionSide: "long" })
    ).toBe(99800);
    expect(estimateReferencePrice({ ...m, orderType: "limit" })).toBe(98000);
    expect(
      estimateReferencePrice({ ...m, orderType: "conditionalMarket" })
    ).toBe(101000);
    expect(
      estimateReferencePrice({ ...m, orderType: "conditionalLimit" })
    ).toBe(98000);
    expect(
      estimateReferencePrice({
        ...m,
        orderType: "conditionalLimit",
        triggerPriceUnits: NaN,
      })
    ).toBeNull();
    expect(
      estimateReferencePrice({
        ...m,
        orderType: "limit",
        limitPriceUnits: null,
      })
    ).toBeNull();
    expect(estimateReferencePrice({ ...m, bidUnits: 999000 })).toBeNull();
    expect(estimateReferencePrice({ ...m, action: "close" })).toBeNull();
  });
  it("recalculates when leverage, price or fee changes without mutating the previous result", () => {
    const old = estimateOrder(config, coin);
    expect(estimateOrder({ ...config, leverage: 2 }, coin)?.costUnits).toBe(
      50060
    );
    expect(
      estimateOrder({ ...config, priceUnits: 200000 }, coin)?.costUnits
    ).toBe(40120);
    expect(estimateOrder({ ...config, takerFeeBps: 0 }, coin)?.costUnits).toBe(
      20000
    );
    expect(old?.costUnits).toBe(20060);
  });
  it("bases slider on the largest affordable whole lot after separate ceilings, even for 100%", () => {
    const c = {
      ...config,
      availableCashUnits: 20_059,
      qtyStepAtoms: 1_000_000,
    };
    expect(maxOrderQuantity(c)).toBe(99_000_000);
    expect(percentageQuantity(c, 100)).toBe(99_000_000);
    expect(percentageQuantity(c, 50)).toBe(49_000_000);
    expect(percentageQuantity(c, 0)).toBe(0);
    expect(estimateOrder(c, coin)).toBeNull();
    expect(estimateOrder(c, 99_000_000)).toMatchObject({
      marginUnits: 19800,
      feeUnits: 60,
      costUnits: 19860,
    });
    expect(maxOrderQuantity({ ...c, availableCashUnits: 20_060 })).toBe(coin);
  });
  it("respects notional headroom, instrument bounds and position direction", () => {
    expect(
      maxOrderQuantity({
        ...config,
        notionalHeadroomUnits: 70_000,
        qtyStepAtoms: 1_000_000,
      })
    ).toBe(70_000_000);
    expect(maxOrderQuantity({ ...config, maxQtyAtoms: 123_456_789 })).toBe(
      123_450_000
    );
    expect(
      maxOrderQuantity({
        ...config,
        position: prev,
        qtyStepAtoms: coin / 10,
        symbolNotionalLimitUnits: 150_000,
      })
    ).toBe(coin / 2);
    expect(maxOrderQuantity({ ...config, minNotionalUnits: 1_000_000 })).toBe(
      0
    );
    expect(
      maxOrderQuantity({ ...config, action: "openShort", position: prev })
    ).toBe(0);
    expect(maxOrderQuantity({ ...config, leverage: 2, position: prev })).toBe(
      0
    );
  });
  it("uses the isolated maintenance formula for long, short and a same-side scale-in", () => {
    expect(estimateOrder(config, coin)).toMatchObject({
      quantityAtoms: coin,
      notionalUnits: 100000,
      costUnits: 20060,
      liquidationPriceUnits: 80402,
    });
    expect(
      estimateOrder({ ...config, action: "openShort" }, coin)
    ).toMatchObject({ liquidationPriceUnits: 119402 });
    expect(
      estimateOrder({ ...config, priceUnits: 200000, position: prev }, coin)
    ).toMatchObject({
      notionalUnits: 200000,
      costUnits: 40120,
      liquidationPriceUnits: 120603,
    });
    expect(
      estimateOrder(
        { ...config, leverage: 1, availableCashUnits: 100_100 },
        coin / 2
      )?.liquidationPriceUnits
    ).toBeNull();
  });
  it("sizes reduce-only by available holdings, caps fee by equity, full close has no liquidation price", () => {
    const c: EstimateInput = {
      ...config,
      action: "close",
      position: prev,
      availableCashUnits: 0,
    };
    expect(percentageQuantity(c, 25)).toBe(coin / 4);
    expect(maxOrderQuantity({ ...c, availableCloseAtoms: coin / 2 })).toBe(
      coin / 2
    );
    expect(estimateOrder(c, coin)).toMatchObject({
      costUnits: 60,
      marginUnits: 0,
      liquidationPriceUnits: null,
    });
    expect(estimateOrder(c, coin / 2)).toMatchObject({
      costUnits: 30,
      liquidationPriceUnits: 80402,
    });
    expect(estimateOrder({ ...c, priceUnits: 80_001 }, coin)).toMatchObject({
      feeUnits: 1,
      costUnits: 1,
    });
    expect(estimateOrder({ ...c, priceUnits: 50_000 }, coin / 2)).toBeNull();
  });
  it.each([
    ["long", 105_000, coin, 20_000, 63, 4_937, 24_937],
    ["long", 95_000, coin / 2, 10_000, 29, -2_529, 7_471],
    ["short", 95_000, coin, 20_000, 57, 4_943, 24_943],
    ["short", 110_000, coin / 2, 10_000, 33, -5_033, 4_967],
    ["long", 50_000, coin, 20_000, 0, -20_000, 0],
    ["long", 80_001, coin, 20_000, 1, -20_000, 0],
  ] as const)(
    "estimates %s closing at %i with quantity %i",
    (
      side,
      priceUnits,
      quantity,
      releasedMarginUnits,
      feeUnits,
      netPnlUnits,
      payoutUnits
    ) => {
      expect(
        estimateOrder(
          {
            ...config,
            action: "close",
            position: { ...prev, side },
            priceUnits,
          },
          quantity
        )
      ).toMatchObject({
        feeUnits,
        close: { releasedMarginUnits, netPnlUnits, payoutUnits },
      });
    }
  );
  it("can reduce a remainder smaller than the opening minimum", () => {
    const c: EstimateInput = {
      ...config,
      action: "close",
      minQtyAtoms: 10_000_000,
      minNotionalUnits: 100_000,
      position: {
        ...prev,
        quantityAtoms: 1_000_000,
        marginUnits: 200,
        entryNotionalUnits: 1000,
      },
    };
    expect(maxOrderQuantity(c)).toBe(1_000_000);
    expect(estimateOrder(c, 1_000_000)).toMatchObject({
      costUnits: 1,
      liquidationPriceUnits: null,
    });
  });
  it("rejects invalid specs and does not overflow during quantity search", () => {
    expect(maxOrderQuantity({ ...config, priceUnits: NaN })).toBe(0);
    expect(estimateOrder(config, 1)).toBeNull();
    expect(maxOrderQuantity({ ...config, qtyStepAtoms: 0 })).toBe(0);
    expect(percentageQuantity(config, 101)).toBe(0);
    const c = {
      ...config,
      availableCashUnits: Number.MAX_SAFE_INTEGER,
      qtyStepAtoms: 1,
      maxQtyAtoms: Number.MAX_SAFE_INTEGER,
      priceUnits: Number.MAX_SAFE_INTEGER,
    };
    const size = maxOrderQuantity(c);
    expect(size).toBe(coin);
    expect(estimateOrder(c, size)?.notionalUnits).toBe(Number.MAX_SAFE_INTEGER);
  });
});
