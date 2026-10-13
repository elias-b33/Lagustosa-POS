export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', method: method ?? (body === undefined ? 'GET' : 'POST'), headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError('NETWORK', 'Anslutningen bröts. Kontrollera om ändringen sparades innan du försöker igen.', 0); }
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.code, result.message, response.status);
  return result as T;
}
export const newKey = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, '0')).join('');
};
