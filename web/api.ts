export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', method: method ?? (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    let result: unknown;
    try { result = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new ApiError(response.ok ? 'RESPONSE_UNCERTAIN' : 'SERVER_ERROR', 'Svaret från kassan kunde inte läsas. Kontrollera om ändringen sparades innan du försöker igen.', response.ok ? 0 : response.status);
    }
    if (!response.ok) {
      const issue = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      throw new ApiError(typeof issue.code === 'string' ? issue.code : 'SERVER_ERROR', typeof issue.message === 'string' ? issue.message : 'Kassan kunde inte slutföra anropet. Kontrollera resultatet innan du försöker igen.', response.status);
    }
    return result as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError('TIMEOUT', 'Kassan svarade inte i tid. Kontrollera om ändringen sparades innan du försöker igen.', 0);
    throw new ApiError('NETWORK', 'Anslutningen bröts. Kontrollera om ändringen sparades innan du försöker igen.', 0);
  } finally { clearTimeout(timeout); }
}
export const newKey = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, '0')).join('');
};
