import { constants, createHash, randomBytes, verify, X509Certificate } from "node:crypto";
import * as asn1 from "asn1js";
import { Certificate, CertificateRevocationList, ExtKeyUsage, IssuerAndSerialNumber, MessageImprint, RelativeDistinguishedNames, SignedData, TimeStampReq, TimeStampResp, TSTInfo, AlgorithmIdentifier } from "pkijs";
import { z } from "zod";
import { requestProof, type ProofNetworkOptions } from "./proof-network";
import { MICROSOFT_TSA_ISSUER_CERT, MICROSOFT_TSA_ISSUER_FINGERPRINT, MICROSOFT_TSA_ROOT_CERT, MICROSOFT_TSA_ROOT_FINGERPRINT } from "./tsa-pins";

export const SEVEN_PICK_TSA = Object.freeze({
  provider: "microsoft-public-rsa-2020",
  url: "https://timestamp.acs.microsoft.com",
  policy: "1.3.6.1.4.1.601.10.3.1",
  rootCrlUrl: "https://www.microsoft.com/pkiops/crl/Microsoft%20Identity%20Verification%20Root%20Certificate%20Authority%202020.crl",
  issuerCrlUrl: "https://www.microsoft.com/pkiops/crl/Microsoft%20Public%20RSA%20Timestamping%20CA%202020.crl",
});

const SHA256 = "2.16.840.1.101.3.4.2.1";
const RSA = "1.2.840.113549.1.1.1";
const RSA_SHA256 = "1.2.840.113549.1.1.11";
const RSA_SHA384 = "1.2.840.113549.1.1.12";
const CMS_SIGNED_DATA = "1.2.840.113549.1.7.2";
const TIMESTAMP_INFO = "1.2.840.113549.1.9.16.1.4";
const TIMESTAMP_EKU = "1.3.6.1.5.5.7.3.8";
const CONTENT_TYPE = "1.2.840.113549.1.9.3";
const MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CRL_BYTES = 32 * 1024;
const MAX_ACCURACY_MICROS = 1_000_000;
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const fingerprint = (cert: X509Certificate) => sha256(cert.raw);
const hex = (maxBytes: number) => z.string().min(2).max(maxBytes * 2).regex(/^(?:[0-9a-f]{2})+$/);
const epoch = z.number().int().nonnegative();
export const sevenPickTsaEvidenceInput = z.strictObject({
  provider: z.literal(SEVEN_PICK_TSA.provider),
  url: z.literal(SEVEN_PICK_TSA.url),
  method: z.literal("POST"),
  requestedAt: epoch,
  receivedAt: epoch,
  statusCode: z.number().int().min(100).max(599).nullable(),
  responseDate: z.string().max(128).nullable(),
  bodyHex: hex(MAX_RESPONSE_BYTES).nullable(),
  error: z.string().max(512).nullable(),
  nonceHex: hex(33).min(16),
  requestHex: hex(512),
  rootCrlHex: hex(MAX_CRL_BYTES).nullable(),
  issuerCrlHex: hex(MAX_CRL_BYTES).nullable(),
});
export type SevenPickTsaEvidence = z.infer<typeof sevenPickTsaEvidenceInput>;
export type TsaStampEvidence = SevenPickTsaEvidence;
export type SevenPickTsaStamp = {
  genTimeMs: number;
  accuracyMs: number;
  upperBoundMs: number;
  signerFingerprint: string;
  policy: string;
};

export class SevenPickTsaRevocationUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "SevenPickTsaRevocationUnavailableError";
  }
}

export class SevenPickTsaRevokedError extends Error {
  constructor() {
    super("RFC 3161: TSA chain certificate is listed as revoked");
    this.name = "SevenPickTsaRevokedError";
  }
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("RFC 3161: " + message);
}

// Bound nesting before parsing recursively, and reject indefinite/non-minimal
// length encodings and leftover data in the enclosing binary object.
function der(bytes: Uint8Array) {
  function element(offset: number, end: number, depth: number): number {
    requireValid(depth <= 24 && offset + 2 <= end, "invalid DER framing");
    const tag = bytes[offset++];
    requireValid(tag !== 0 && (tag & 31) !== 31, "unsupported DER tag");
    let length = bytes[offset++];
    if (length & 128) {
      const width = length & 127;
      requireValid(width >= 1 && width <= 3 && offset + width <= end && bytes[offset] !== 0, "invalid DER length");
      length = 0;
      for (let i = 0; i < width; i++) length = length * 256 + bytes[offset++];
      requireValid(length >= 128, "non-minimal DER length");
    }
    const next = offset + length;
    requireValid(next <= end, "truncated DER");
    if (tag & 32) while (offset < next) offset = element(offset, next, depth + 1);
    return next;
  }
  requireValid(element(0, bytes.length, 0) === bytes.length, "trailing DER data");
  const parsed = asn1.fromBER(bytes);
  requireValid(parsed.offset === bytes.length && parsed.result instanceof asn1.Sequence, "invalid DER sequence");
  return parsed.result;
}

function digestCheck(digestHex: string, imprint: MessageImprint) {
  requireValid(imprint.hashAlgorithm.algorithmId === SHA256 &&
    (imprint.hashAlgorithm.algorithmParams === undefined || imprint.hashAlgorithm.algorithmParams instanceof asn1.Null) &&
    Buffer.from(imprint.hashedMessage.getValue()).toString("hex") === digestHex, "SHA-256 imprint does not match");
}

function integerHex(node: asn1.Integer) {
  return Buffer.from(node.valueBlock.valueHexView).toString("hex");
}

function nonceBytes(value: string) {
  const bytes = Buffer.from(hex(33).min(16).parse(value), "hex");
  requireValid((bytes[0] & 128) === 0 && (bytes[0] !== 0 || (bytes[1] & 128) !== 0), "nonce is not a canonical positive integer");
  return bytes;
}

export function buildSevenPickTsaRequest(imprintHex: string) {
  requireValid(/^[0-9a-f]{64}$/.test(imprintHex), "invalid message imprint format");
  const random = randomBytes(16);
  random[0] |= 128;
  const nonce = Buffer.concat([Buffer.from([0]), random]);
  const request = new TimeStampReq({
    version: 1,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: SHA256, algorithmParams: new asn1.Null() }),
      hashedMessage: new asn1.OctetString({ valueHex: Buffer.from(imprintHex, "hex") }),
    }),
    reqPolicy: SEVEN_PICK_TSA.policy,
    nonce: new asn1.Integer({ valueHex: nonce }),
    certReq: true,
  });
  return { nonceHex: nonce.toString("hex"), requestHex: Buffer.from(request.toSchema().toBER(false)).toString("hex") };
}

export async function refreshSevenPickTsaRevocation(evidence: SevenPickTsaEvidence, options: ProofNetworkOptions = {}): Promise<SevenPickTsaEvidence> {
  const headers = { Accept: "application/pkix-crl, application/octet-stream" };
  const [root, issuer] = await Promise.all([
    requestProof(SEVEN_PICK_TSA.rootCrlUrl, { method: "GET", headers }, MAX_CRL_BYTES, options),
    requestProof(SEVEN_PICK_TSA.issuerCrlUrl, { method: "GET", headers }, MAX_CRL_BYTES, options),
  ]);
  return {
    ...evidence,
    rootCrlHex: root.statusCode === 200 && root.bodyHex ? root.bodyHex : evidence.rootCrlHex,
    issuerCrlHex: issuer.statusCode === 200 && issuer.bodyHex ? issuer.bodyHex : evidence.issuerCrlHex,
  };
}

export async function requestSevenPickTsaStamp(imprintHex: string, options: ProofNetworkOptions = {}): Promise<SevenPickTsaEvidence> {
  const request = buildSevenPickTsaRequest(imprintHex);
  const body = Uint8Array.from(Buffer.from(request.requestHex, "hex"));
  const timestamp = requestProof(SEVEN_PICK_TSA.url, {
    method: "POST", headers: { "Content-Type": "application/timestamp-query", Accept: "application/timestamp-reply" }, body,
  }, MAX_RESPONSE_BYTES, options);
  const [observed, revocation] = await Promise.all([timestamp, refreshSevenPickTsaRevocation({
    ...request, provider: SEVEN_PICK_TSA.provider, url: SEVEN_PICK_TSA.url, method: "POST",
    requestedAt: 0, receivedAt: 0, statusCode: null, responseDate: null, bodyHex: null, error: null,
    rootCrlHex: null, issuerCrlHex: null,
  }, options)]);
  return { ...revocation, ...observed, url: SEVEN_PICK_TSA.url, method: "POST", bodyHex: observed.bodyHex || null };
}

function precisionBounds(time: asn1.GeneralizedTime, info: TSTInfo) {
  const value = Buffer.from(time.valueBlock.valueHexView).toString("latin1");
  const parts = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{0,5}[1-9]))?Z$/.exec(value);
  requireValid(parts, "invalid or unsupported signed UTC time precision");
  const iso = parts[1] + "-" + parts[2] + "-" + parts[3] + "T" + parts[4] + ":" + parts[5] + ":" + parts[6];
  const wholeSecondsMs = Date.parse(iso + "Z");
  requireValid(Number.isSafeInteger(wholeSecondsMs) && wholeSecondsMs > 0 && new Date(wholeSecondsMs).toISOString().slice(0, 19) === iso, "invalid calendar time");
  const fractionMicros = Number((parts[7] ?? "").padEnd(6, "0"));
  requireValid(info.accuracy, "missing signed timestamp accuracy");
  const { seconds = 0, millis = 0, micros = 0 } = info.accuracy;
  requireValid(Number.isInteger(seconds) && seconds >= 0 && seconds <= 1 && Number.isInteger(millis) && millis >= 0 && millis <= 999 &&
    Number.isInteger(micros) && micros >= 0 && micros <= 999, "invalid signed accuracy");
  const accuracyMicros = seconds * 1_000_000 + millis * 1000 + micros;
  requireValid(accuracyMicros > 0 && accuracyMicros <= MAX_ACCURACY_MICROS, "signed accuracy exceeds the permitted clock bound");
  return {
    genTimeMs: wholeSecondsMs + Math.floor(fractionMicros / 1000),
    accuracyMs: accuracyMicros / 1000,
    lowerBoundMs: wholeSecondsMs + Math.floor((fractionMicros - accuracyMicros) / 1000),
    upperBoundMs: wholeSecondsMs + Math.ceil((fractionMicros + accuracyMicros) / 1000),
  };
}

const root = new X509Certificate(Buffer.from(MICROSOFT_TSA_ROOT_CERT, "base64"));
const issuer = new X509Certificate(Buffer.from(MICROSOFT_TSA_ISSUER_CERT, "base64"));
const parsedRoot = Certificate.fromBER(root.raw);
const parsedIssuer = Certificate.fromBER(issuer.raw);

function validDate(cert: X509Certificate, lower: number, upper: number) {
  requireValid(Date.parse(cert.validFrom) <= lower && Date.parse(cert.validTo) >= upper, "certificate not valid throughout signed time interval");
}

function verifyPinnedChain(leaf: X509Certificate, parsedLeaf: Certificate, lower: number, upper: number) {
  requireValid(fingerprint(root) === MICROSOFT_TSA_ROOT_FINGERPRINT && fingerprint(issuer) === MICROSOFT_TSA_ISSUER_FINGERPRINT &&
    root.ca && issuer.ca && root.checkIssued(root) && root.verify(root.publicKey) &&
    issuer.checkIssued(root) && issuer.verify(root.publicKey) &&
    !leaf.ca && leaf.checkIssued(issuer) && leaf.verify(issuer.publicKey), "invalid chain to pinned Microsoft TSA issuer");
  const eku = parsedLeaf.extensions?.filter((ext) => ext.extnID === "2.5.29.37") ?? [];
  const usage = parsedLeaf.extensions?.filter((ext) => ext.extnID === "2.5.29.15") ?? [];
  requireValid(eku.length === 1 && eku[0].critical && eku[0].parsedValue instanceof ExtKeyUsage &&
    eku[0].parsedValue.keyPurposes.length === 1 && eku[0].parsedValue.keyPurposes[0] === TIMESTAMP_EKU &&
    usage.length === 1 && usage[0].critical && usage[0].parsedValue instanceof asn1.BitString &&
    Buffer.from(usage[0].parsedValue.valueBlock.valueHexView).equals(Buffer.from([128])), "invalid dedicated timestamp signing certificate usage");
  requireValid(parsedLeaf.extensions?.every((ext) => !ext.critical || ["2.5.29.15", "2.5.29.19", "2.5.29.37"].includes(ext.extnID)), "unknown critical certificate extension");
  requireValid(leaf.publicKey.asymmetricKeyType === "rsa" && (leaf.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, "unsupported TSA signing key");
  for (const cert of [root, issuer, leaf]) validDate(cert, lower, upper);
}

function verifyRevocation(rawHex: string | null, certificate: Certificate, ca: Certificate, caNative: X509Certificate, lower: number, upper: number) {
  requireValid(rawHex, "missing archived revocation list");
  const crl = new CertificateRevocationList({ schema: der(Buffer.from(rawHex, "hex")) });
  requireValid(crl.issuer.isEqual(ca.subject) && crl.signature.algorithmId === crl.signatureAlgorithm.algorithmId, "CRL issuer or signature parameters mismatch");
  const algorithm = crl.signatureAlgorithm.algorithmId === RSA_SHA384 ? "sha384" : crl.signatureAlgorithm.algorithmId === RSA_SHA256 ? "sha256" : null;
  requireValid(algorithm && verify(algorithm, crl.tbsView, caNative.publicKey, crl.signatureValue.valueBlock.valueHexView), "invalid CRL signature");
  requireValid(crl.thisUpdate.value.getTime() <= lower && (crl.nextUpdate?.value.getTime() ?? 0) >= upper, "CRL does not cover signed time interval");
  requireValid(crl.crlExtensions?.extensions.every((ext) => !ext.critical && ext.extnID !== "2.5.29.27" && ext.extnID !== "2.5.29.28") ?? false,
    "unsupported CRL type or critical extension");
  if (crl.revokedCertificates?.some((value) => integerHex(value.userCertificate) === integerHex(certificate.serialNumber))) {
    throw new SevenPickTsaRevokedError();
  }
}

function verifyContent(data: SignedData, leaf: X509Certificate, parsedLeaf: Certificate, tstDer: Uint8Array) {
  requireValid(data.signerInfos.length === 1 && data.digestAlgorithms.length === 1 &&
    data.digestAlgorithms[0].algorithmId === SHA256, "invalid CMS signers or digest algorithms");
  const signer = data.signerInfos[0];
  requireValid(signer.sid instanceof IssuerAndSerialNumber && signer.sid.issuer.isEqual(parsedLeaf.issuer) &&
    integerHex(signer.sid.serialNumber) === integerHex(parsedLeaf.serialNumber), "CMS signer identifier does not match certificate");
  requireValid(signer.digestAlgorithm.algorithmId === SHA256 && [RSA, RSA_SHA256].includes(signer.signatureAlgorithm.algorithmId) &&
    signer.signedAttrs && !signer.unsignedAttrs, "unsupported CMS signature algorithms or attributes");
  const attributes = signer.signedAttrs.attributes;
  requireValid(new Set(attributes.map((attribute) => attribute.type)).size === attributes.length, "duplicate CMS signed attribute");
  function value(oid: string) {
    const attribute = attributes.find((entry) => entry.type === oid);
    requireValid(attribute && attribute.values.length === 1, "invalid CMS signed attribute " + oid);
    return attribute.values[0] as unknown;
  }
  const contentType = value(CONTENT_TYPE);
  requireValid(contentType instanceof asn1.ObjectIdentifier && contentType.valueBlock.toString() === TIMESTAMP_INFO, "wrong CMS content type");
  const messageDigest = value(MESSAGE_DIGEST);
  requireValid(messageDigest instanceof asn1.OctetString && Buffer.from(messageDigest.getValue()).toString("hex") === sha256(tstDer), "TSTInfo digest mismatch");
  // The pinned provider uses ESSCertIDv2 with the default SHA-256. Validate
  // the digest of the exact signer certificate, rather than a subject string.
  const ess = value(SIGNING_CERTIFICATE_V2);
  requireValid(ess instanceof asn1.Sequence && ess.valueBlock.value.length === 1, "invalid ESS signing certificate v2");
  const certs = ess.valueBlock.value[0];
  requireValid(certs instanceof asn1.Sequence && certs.valueBlock.value.length === 1, "unexpected ESS certificate list");
  const certId = certs.valueBlock.value[0];
  requireValid(certId instanceof asn1.Sequence && certId.valueBlock.value.length === 2, "invalid ESS certificate identifier");
  const certHash = certId.valueBlock.value[0];
  const issuerSerial = certId.valueBlock.value[1];
  requireValid(certHash instanceof asn1.OctetString && Buffer.from(certHash.getValue()).toString("hex") === fingerprint(leaf) &&
    issuerSerial instanceof asn1.Sequence && issuerSerial.valueBlock.value.length === 2, "ESS signer certificate hash mismatch");
  const issuerNames = issuerSerial.valueBlock.value[0];
  const serial = issuerSerial.valueBlock.value[1];
  requireValid(issuerNames instanceof asn1.Sequence && issuerNames.valueBlock.value.length === 1 &&
    serial instanceof asn1.Integer && integerHex(serial) === integerHex(parsedLeaf.serialNumber), "ESS signer serial mismatch");
  const name = issuerNames.valueBlock.value[0];
  requireValid(name instanceof asn1.Constructed && name.idBlock.tagClass === 3 && name.idBlock.tagNumber === 4 && name.valueBlock.value.length === 1 &&
    new RelativeDistinguishedNames({ schema: name.valueBlock.value[0] }).isEqual(parsedLeaf.issuer), "ESS signer issuer mismatch");
  const encodedAttrs = Buffer.from(signer.signedAttrs.encodedValue);
  requireValid(encodedAttrs[0] === 0x31 && verify("sha256", encodedAttrs, {
    key: leaf.publicKey, padding: constants.RSA_PKCS1_PADDING,
  }, Buffer.from(signer.signature.getValue())), "invalid timestamp CMS signature");
}

/** Uses only pinned trust, the supplied nonce/request, and signed archives. Does not use HTTP dates or a local wall clock. */
export function verifySevenPickTsaStamp(imprintHex: string, rawEvidence: unknown): SevenPickTsaStamp {
  requireValid(/^[0-9a-f]{64}$/.test(imprintHex), "invalid message imprint format");
  const evidence = sevenPickTsaEvidenceInput.parse(rawEvidence);
  requireValid(evidence.statusCode === 200 && evidence.bodyHex !== null && !evidence.error, "missing complete timestamp response");
  nonceBytes(evidence.nonceHex);
  const request = new TimeStampReq({ schema: der(Buffer.from(evidence.requestHex, "hex")) });
  requireValid(request.version === 1 && request.certReq && request.nonce && integerHex(request.nonce) === evidence.nonceHex &&
    (!request.reqPolicy || request.reqPolicy === SEVEN_PICK_TSA.policy) && !request.extensions?.length, "invalid archived request or nonce");
  digestCheck(imprintHex, request.messageImprint);

  const response = new TimeStampResp({ schema: der(Buffer.from(evidence.bodyHex, "hex")) });
  requireValid(response.status.status === 0 && response.timeStampToken?.contentType === CMS_SIGNED_DATA, "TSA did not grant request");
  const data = new SignedData({ schema: response.timeStampToken.content });
  requireValid(data.encapContentInfo.eContentType === TIMESTAMP_INFO && data.encapContentInfo.eContent instanceof asn1.OctetString,
    "missing embedded TSTInfo");
  const tstDer = new Uint8Array(data.encapContentInfo.eContent.getValue());
  const schema = der(tstDer);
  const info = new TSTInfo({ schema });
  requireValid(info.version === 1 && info.policy === SEVEN_PICK_TSA.policy && !info.extensions?.length &&
    info.nonce && integerHex(info.nonce) === evidence.nonceHex, "timestamp policy or nonce mismatch");
  digestCheck(imprintHex, info.messageImprint);
  const time = schema.valueBlock.value[4];
  requireValid(time instanceof asn1.GeneralizedTime, "missing signed timestamp");
  const { genTimeMs, accuracyMs, lowerBoundMs, upperBoundMs } = precisionBounds(time, info);
  requireValid(data.certificates?.length && data.certificates.length <= 3 && data.certificates.every((cert) => cert instanceof Certificate), "invalid CMS certificate list");
  const certs = data.certificates.map((cert) => ({ parsed: cert as Certificate, native: new X509Certificate(Buffer.from((cert as Certificate).toSchema().toBER(false))) }));
  const signers = certs.filter(({ native }) => !native.ca);
  requireValid(signers.length === 1 && certs.every(({ native }) => !native.ca || [MICROSOFT_TSA_ROOT_FINGERPRINT, MICROSOFT_TSA_ISSUER_FINGERPRINT].includes(fingerprint(native))), "unexpected CMS certificate");
  const { parsed, native } = signers[0];
  if (info.tsa) {
    requireValid(info.tsa.type === 4 && info.tsa.value instanceof RelativeDistinguishedNames && info.tsa.value.isEqual(parsed.subject), "TSTInfo TSA name mismatch");
  }
  verifyPinnedChain(native, parsed, lowerBoundMs, upperBoundMs);
  verifyContent(data, native, parsed, tstDer);
  let revocationError: unknown;
  for (const [crl, cert, ca, nativeCa] of [
    [evidence.rootCrlHex, parsedIssuer, parsedRoot, root],
    [evidence.issuerCrlHex, parsed, parsedIssuer, issuer],
  ] as const) {
    try {
      verifyRevocation(crl, cert, ca, nativeCa, lowerBoundMs, upperBoundMs);
    } catch (error) {
      if (error instanceof SevenPickTsaRevokedError) throw error;
      revocationError ??= error;
    }
  }
  if (revocationError !== undefined) {
    const message = revocationError instanceof Error ? revocationError.message : "RFC 3161: unavailable revocation evidence";
    throw new SevenPickTsaRevocationUnavailableError(message, revocationError);
  }
  return { genTimeMs, accuracyMs, upperBoundMs, signerFingerprint: fingerprint(native), policy: info.policy };
}
