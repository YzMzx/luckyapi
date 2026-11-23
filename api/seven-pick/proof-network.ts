export type ProofNetworkOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export type ProofHttpEvidence = {
  url: string;
  method: "GET" | "POST";
  requestedAt: number;
  receivedAt: number;
  statusCode: number | null;
  responseDate: string | null;
  bodyHex: string | null;
  error: string | null;
};

async function readBody(response: Response, limit: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(parts, length);
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("Response exceeds proof size limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function requestProof(
  url: string,
  request: Pick<RequestInit, "headers" | "body"> & { method: "GET" | "POST" },
  byteLimit: number,
  options: ProofNetworkOptions,
): Promise<ProofHttpEvidence> {
  const now = options.now ?? Date.now;
  const requestedAt = now();
  let statusCode: number | null = null;
  let responseDate: string | null = null;
  let bodyHex: string | null = null;
  let error: string | null = null;
  try {
    const response = await (options.fetch ?? fetch)(url, {
      ...request,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    statusCode = response.status;
    responseDate = response.headers.get("date");
    bodyHex = (await readBody(response, byteLimit)).toString("hex");
  } catch (failure) {
    error = String(failure).slice(0, 512);
  }
  return { url, method: request.method, requestedAt, receivedAt: now(), statusCode, responseDate, bodyHex, error };
}
