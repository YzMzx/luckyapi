import { describe, expect, it } from "vitest";
import { fetchQuicknetRound, QUICKNET, verifyQuicknetBeacon } from "./drand";

const signature = "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b";
const randomness = "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a";
const beforeTarget = 1_795_400_000_000;

describe("Quicknet fixed round", () => {
  it("checks the public v2 beacon and derives randomness for a known real round", () => {
    expect(verifyQuicknetBeacon(1, { round: 1, signature })).toEqual({ round: 1, signature, randomness });
    expect(verifyQuicknetBeacon(1, { round: 1, signature, randomness })).toEqual({ round: 1, signature, randomness });
    expect(() => verifyQuicknetBeacon(2, { round: 2, signature })).toThrow();
    expect(() => verifyQuicknetBeacon(1, { round: 2, signature })).toThrow();
    expect(() => verifyQuicknetBeacon(1, { round: 1, signature: signature.slice(0, -2) + "00" })).toThrow();
    expect(() => verifyQuicknetBeacon(1, { round: 1, signature: "c0" + "00".repeat(47) })).toThrow();
    expect(() => verifyQuicknetBeacon(1, { round: 1, signature, randomness: "00".repeat(32) })).toThrow();
  });

  it("queries two pinned relays without altering the round and retains both responses", async () => {
    const urls: string[] = [];
    const result = await fetchQuicknetRound(1, {
      fetch: async (input, init) => {
        expect(init?.redirect).toBe("error");
        urls.push(String(input));
        if (String(input).includes("cloudflare")) return new Response("not available", { status: 404 });
        return Response.json({ round: 1, signature });
      },
      now: () => beforeTarget,
    });
    expect(urls).toEqual([
      "https://api.drand.sh/v2/beacons/quicknet/rounds/1",
      "https://drand.cloudflare.com/" + QUICKNET.chainHash + "/public/1",
    ]);
    expect(result.beacon?.randomness).toBe(randomness);
    expect(result.evidence.map(({ statusCode, verdict, bodyHex }) => ({ statusCode, verdict, hasBody: bodyHex !== null }))).toEqual([
      { statusCode: 200, verdict: "verified", hasBody: true },
      { statusCode: 404, verdict: "unavailable", hasBody: true },
    ]);
  });

  it("records transport, wrong-round and oversized evidence without returning a beacon", async () => {
    const result = await fetchQuicknetRound(1, {
      fetch: async (input) => String(input).includes("cloudflare") ? new Response("0".repeat(8193)) : Response.json({ round: 2, signature }),
    });
    expect(result.beacon).toBe(null);
    expect(result.evidence.map(({ verdict }) => verdict)).toEqual(["invalid", "unavailable"]);
    expect(result.evidence[1].error).toContain("size limit");
    const failed = await fetchQuicknetRound(1, { fetch: async () => { throw new TypeError("mock unavailable"); } });
    expect(failed.beacon).toBe(null);
    expect(failed.evidence.every(({ statusCode, error }) => statusCode === null && error?.includes("mock unavailable"))).toBe(true);
  });
});
