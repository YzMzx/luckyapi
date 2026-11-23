import { createHash } from "node:crypto";
import { TimeStampReq } from "pkijs";
import { describe, expect, it, vi } from "vitest";
import { TSA_TEST_ISSUER_CRL, TSA_TEST_REQUEST, TSA_TEST_RESPONSE, TSA_TEST_ROOT_CRL } from "./tsa.fixture";
import { buildSevenPickTsaRequest, requestSevenPickTsaStamp, SEVEN_PICK_TSA, verifySevenPickTsaStamp, type SevenPickTsaEvidence } from "./tsa";

const imprintHex = createHash("sha256").update("LuckyAPI FreeTSA pinned probe").digest("hex");
const request = TimeStampReq.fromBER(Buffer.from(TSA_TEST_REQUEST, "base64"));
const asHex = (data: string) => Buffer.from(data, "base64").toString("hex");
const fixture: SevenPickTsaEvidence = {
  provider: SEVEN_PICK_TSA.provider,
  url: SEVEN_PICK_TSA.url,
  method: "POST",
  statusCode: 200,
  error: null,
  requestedAt: 0, receivedAt: 0, responseDate: null,
  nonceHex: Buffer.from(request.nonce!.valueBlock.valueHexView).toString("hex"),
  requestHex: asHex(TSA_TEST_REQUEST),
  bodyHex: asHex(TSA_TEST_RESPONSE),
  rootCrlHex: asHex(TSA_TEST_ROOT_CRL),
  issuerCrlHex: asHex(TSA_TEST_ISSUER_CRL),
};

function mutate(hex: string, byteIndex: number) {
  const raw = Buffer.from(hex, "hex");
  raw[byteIndex < 0 ? raw.length + byteIndex : byteIndex] ^= 1;
  return raw.toString("hex");
}

describe("pinned Microsoft RFC 3161 time evidence", () => {
  it("verifies the real CMS signature, archived CRLs and signed accuracy offline", () => {
    expect(verifySevenPickTsaStamp(imprintHex, fixture)).toEqual({
      genTimeMs: Date.parse("2026-11-23T11:18:55.746Z"),
      accuracyMs: 500,
      upperBoundMs: Date.parse("2026-11-23T11:18:56.246Z"),
      signerFingerprint: "6cf6097eab57f480e0d28524f44ab0b7505e6c9c79d6e27f305e52c75b2e25c3",
      policy: "1.3.6.1.4.1.601.10.3.1",
    });
    expect(verifySevenPickTsaStamp(imprintHex, {
      ...fixture, requestedAt: 9, receivedAt: 10, responseDate: "Mon, 01 Jan 2001 01:01:00 GMT",
    })).toEqual(verifySevenPickTsaStamp(imprintHex, fixture));
  });

  it("rejects swapped envelopes, archive nonce and wrong request", () => {
    expect(() => verifySevenPickTsaStamp("ab".repeat(32), fixture)).toThrow("imprint");
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, nonceHex: mutate(fixture.nonceHex, -1) })).toThrow("nonce");
    const newRequest = buildSevenPickTsaRequest(imprintHex);
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, ...newRequest })).toThrow("nonce mismatch");
  });

  it("rejects vendor substitution, signed payload edits and trailing data", () => {
    const raw = fixture.bodyHex!;
    const signedTime = Buffer.from("20261123111855.746Z").toString("hex");
    const changedTime = Buffer.from("20261123111955.746Z").toString("hex");
    expect(raw).toContain(signedTime);
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, url: "https://freetsa.org/tsr" })).toThrow();
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, bodyHex: raw.replace(signedTime, changedTime) })).toThrow("TSTInfo digest mismatch");
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, bodyHex: mutate(raw, -1) })).toThrow("invalid timestamp CMS signature");
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, bodyHex: raw + "00" })).toThrow("trailing DER data");
  });

  it("checks both revocation archives and rejects tampering or swapping", () => {
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, rootCrlHex: null })).toThrow("missing archived revocation list");
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, issuerCrlHex: mutate(fixture.issuerCrlHex!, -1) })).toThrow("invalid CRL signature");
    expect(() => verifySevenPickTsaStamp(imprintHex, { ...fixture, rootCrlHex: fixture.issuerCrlHex })).toThrow("CRL issuer");
  });

  it("sends a SHA-256 request with certificate requirement, policy and independent nonce", async () => {
    const backend = vi.fn<typeof fetch>();
    backend.mockImplementation(async (resource) => {
      const url = String(resource);
      const body = url === SEVEN_PICK_TSA.url ? TSA_TEST_RESPONSE : url === SEVEN_PICK_TSA.rootCrlUrl ? TSA_TEST_ROOT_CRL : TSA_TEST_ISSUER_CRL;
      return new Response(Uint8Array.from(Buffer.from(body, "base64")));
    });
    const proof = await requestSevenPickTsaStamp(imprintHex, { fetch: backend });
    expect(backend.mock.calls.map(([url]) => url)).toEqual([SEVEN_PICK_TSA.url, SEVEN_PICK_TSA.rootCrlUrl, SEVEN_PICK_TSA.issuerCrlUrl]);
    expect(backend.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    const sent = TimeStampReq.fromBER(Buffer.from(proof.requestHex, "hex"));
    expect(sent.certReq).toBe(true);
    expect(sent.reqPolicy).toBe(SEVEN_PICK_TSA.policy);
    expect(proof.nonceHex).toHaveLength(34);
    expect(Buffer.from(sent.messageImprint.hashedMessage.getValue()).toString("hex")).toBe(imprintHex);
    expect(proof).toMatchObject({ bodyHex: fixture.bodyHex, rootCrlHex: fixture.rootCrlHex, issuerCrlHex: fixture.issuerCrlHex });
    expect(() => verifySevenPickTsaStamp(imprintHex, proof)).toThrow("nonce mismatch");
  });
});
