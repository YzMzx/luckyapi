import type { PerpOrderBook } from "./depth";

// Only tests may deliberately project a legacy ticker onto unlimited-for-test depth.
export function withTestDepth<
  T extends {
    symbol: string;
    bidUnits: number;
    askUnits: number;
    asOf: number;
  },
>(quote: T): T & { orderBook: PerpOrderBook } {
  return {
    ...quote,
    orderBook: {
      symbol: quote.symbol,
      asOf: quote.asOf,
      sequence: quote.asOf,
      bids: [
        { priceUnits: quote.bidUnits, quantityAtoms: Number.MAX_SAFE_INTEGER },
      ],
      asks: [
        { priceUnits: quote.askUnits, quantityAtoms: Number.MAX_SAFE_INTEGER },
      ],
    },
  };
}
