export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** An explicit installation must match; never silently redirect a write to another one. */
export function selectInstallation<T extends { id: string }>(
  installations: T[],
  requested: string | null,
): T | null {
  if (requested !== null)
    return installations.find((row) => row.id === requested) ?? null;
  return installations.length === 1 ? installations[0] : null;
}

/** Enforce the byte limit while reading, including chunked requests without Content-Length. */
export async function boundedJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new RequestError("Leveransen är för stor.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("JSON-underlag saknas.", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RequestError("Leveransen är för stor.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError("Kontrollera JSON-underlaget.", 400);
  }
}
