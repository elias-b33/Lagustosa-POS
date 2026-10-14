import { z } from 'zod';

// Only Softpay's sandbox is reachable. Production URLs are deliberately not configurable.
export const SOFTPAY_SANDBOX_API = 'https://api.sandbox.softpay.io/api-gateway/v3/api/cloud/transactions';
export const SOFTPAY_SANDBOX_TOKEN = 'https://auth.sandbox.softpay.io/oauth2/token';
export type SoftpayTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface SoftpayCredentials { clientId: string; clientSecret: string; merchantReference?: string }
export interface SoftpayTransactionRequest {
  appId: string; amount: number; currencyCode: 'SEK'; posReferenceNumber: string;
  options: { tipping: { indicator: 'OFF' }; surcharge: false; dcc: false; suppressAppNotification: false };
}

export class SoftpayError extends Error {
  constructor(readonly code: 'transport' | 'authentication' | 'http' | 'invalid_response', readonly httpStatus?: number) {
    // Never include credentials, request headers or the provider's raw response.
    super(`Softpay sandbox: ${code}`);
  }
}
const requestIdSchema = z.object({ requestId: z.uuid() });
const tokenSchema = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string().refine(value => value.toLowerCase() === 'bearer'), expires_in: z.number().int().min(1).max(86400) });
export const softpayResultSchema = z.object({
  requestId: z.uuid(), state: z.string().min(1).max(40),
  transactionId: z.string().min(1).max(100).nullish(), appId: z.string().max(80).nullish(),
  storeId: z.number().int().positive().safe().nullish(), type: z.string().max(40).nullish(),
  amountValue: z.number().int().nonnegative().safe().nullish(), currencyCode: z.string().max(3).nullish(),
  amountTips: z.number().int().nonnegative().safe().nullish(), amountSurcharge: z.number().int().nonnegative().safe().nullish(),
  posReferenceNumber: z.string().max(32).nullish(), responseCode: z.string().max(100).nullish(),
});
export type SoftpayResult = z.infer<typeof softpayResultSchema>;

export class SoftpaySandboxClient {
  private cachedToken?: { value: string; expiresAt: number };
  private tokenInFlight?: Promise<string>;
  constructor(private credentials: SoftpayCredentials, private transport: SoftpayTransport = fetch, private now = () => Date.now()) {}

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new SoftpayError(response.status === 401 || response.status === 403 ? 'authentication' : 'http', response.status);
      // Bound the body before JSON parsing; no raw provider response is logged or persisted.
      const reader = response.body?.getReader();
      if (!reader) throw new SoftpayError('invalid_response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65536) { await reader.cancel(); throw new SoftpayError('invalid_response'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof SoftpayError) throw error;
      throw new SoftpayError(error instanceof SyntaxError ? 'invalid_response' : 'transport');
    }
  }
  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) return this.cachedToken.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    const pending = (async () => {
      const basic = Buffer.from(`${encodeURIComponent(this.credentials.clientId)}:${encodeURIComponent(this.credentials.clientSecret)}`).toString('base64');
      const raw = await this.request(SOFTPAY_SANDBOX_TOKEN, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
      const parsed = tokenSchema.safeParse(raw);
      if (!parsed.success) throw new SoftpayError('invalid_response');
      const token = parsed.data;
      this.cachedToken = { value: token.access_token, expiresAt: this.now() + Math.max(0, token.expires_in - 30) * 1000 };
      return token.access_token;
    })();
    this.tokenInFlight = pending;
    try { return await pending; } finally { this.tokenInFlight = undefined; }
  }
  private async call(suffix: string, method: 'POST' | 'PUT' | 'GET', body?: unknown): Promise<unknown> {
    const token = await this.token();
    try {
      return await this.request(`${SOFTPAY_SANDBOX_API}${suffix}`, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.credentials.merchantReference ? { 'X-Softpay-Merchant-Reference': this.credentials.merchantReference } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof SoftpayError && error.httpStatus === 401) this.cachedToken = undefined;
      // A timed-out PUT must never be retried automatically. Only GET can establish its outcome.
      throw error;
    }
  }
  async create(action: 'PAYMENT' | 'REFUND'): Promise<string> {
    const parsed = requestIdSchema.safeParse(await this.call('', 'POST', { action }));
    if (!parsed.success) throw new SoftpayError('invalid_response');
    return parsed.data.requestId;
  }
  async start(requestId: string, transaction: SoftpayTransactionRequest): Promise<void> {
    requestIdSchema.parse({ requestId });
    const reply = await this.call(`/${requestId}`, 'PUT', transaction);
    const parsed = z.object({ requestId: z.uuid(), state: z.string() }).safeParse(reply);
    if (!parsed.success || parsed.data.requestId !== requestId) throw new SoftpayError('invalid_response');
    // This is an acknowledgement, even if its state says COMPLETED. Read full transaction details.
  }
  async read(requestId: string): Promise<SoftpayResult> {
    requestIdSchema.parse({ requestId });
    const parsed = softpayResultSchema.safeParse(await this.call(`/${requestId}`, 'GET'));
    if (!parsed.success || parsed.data.requestId !== requestId) throw new SoftpayError('invalid_response');
    return parsed.data;
  }
  async abort(requestId: string): Promise<void> {
    requestIdSchema.parse({ requestId });
    await this.call(`/${requestId}/abort`, 'PUT');
    // /cancel can reverse an already completed transaction. The cashier's Avbryt uses /abort.
  }
}
