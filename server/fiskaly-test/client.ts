import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FISKALY_API_VERSION, FISKALY_TEST_ORIGIN, parseFiskalyTestConfig, type FiskalyTestConfig } from './config';

const identifier = z.uuid({ version: 'v7' });
const idempotencyKey = z.uuid({ version: 'v4' });
export class FiskalyTestError extends Error {
  constructor(readonly code: 'AUTH' | 'HTTP' | 'TRANSPORT' | 'RESPONSE', readonly status?: number) {
    super(`Fiskaly TEST: ${code}${status ? ` (${status})` : ''}. Resultatet måste kontrolleras med samma referens.`);
  }
}
const MAX_RESPONSE = 1024 * 1024;
// This client is NOT a FiscalAdapter: a 200/COMPLETED response alone must never
// approve a sale. Swedish compliance data decoding awaits vendor verification.
export class FiskalyTestClient {
  readonly config: FiskalyTestConfig;
  private token?: { bearer: string; expires: number };
  private authentication?: Promise<string>;
  constructor(config: FiskalyTestConfig, private request: typeof fetch = fetch, private now = () => Date.now()) { this.config = parseFiskalyTestConfig(config); }
  private async http(route: string, method: 'GET' | 'POST', body?: unknown, bearer?: string, key?: string): Promise<any> {
    let response: Response;
    try {
      response = await this.request(`${FISKALY_TEST_ORIGIN}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'X-Api-Version': FISKALY_API_VERSION, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey.parse(key) } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}`, 'X-Scope-Identifier': this.config.unitId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new FiskalyTestError('TRANSPORT'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new FiskalyTestError(response.status === 401 ? 'AUTH' : 'HTTP', response.status); }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel().catch(() => {}); throw new FiskalyTestError('RESPONSE'); }
    const reader = response.body?.getReader();
    if (!reader) throw new FiskalyTestError('RESPONSE');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_RESPONSE) throw new FiskalyTestError('RESPONSE'); chunks.push(part.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { await reader.cancel().catch(() => {}); throw new FiskalyTestError('RESPONSE'); }
    finally { reader.releaseLock(); }
  }
  private async bearer(): Promise<string> {
    if (this.token && this.token.expires > this.now() + 30000) return this.token.bearer;
    if (this.authentication) return this.authentication;
    this.authentication = (async () => {
      const response = await this.http('/tokens', 'POST', { content: { type: 'API_KEY', key: this.config.apiKey, secret: this.config.apiSecret } }, undefined, randomUUID());
      const authentication = response?.content?.authentication;
      const expires = Date.parse(authentication?.expires_at);
      if (authentication?.type !== 'JWT' || typeof authentication.bearer !== 'string' || !authentication.bearer || !Number.isFinite(expires) || expires <= this.now() + 30000) throw new FiskalyTestError('RESPONSE');
      this.token = { bearer: authentication.bearer, expires };
      return this.token.bearer;
    })();
    try { return await this.authentication; } finally { this.authentication = undefined; }
  }
  private async authenticated(route: string, method: 'GET' | 'POST', body?: unknown, key?: string) {
    try { return await this.http(route, method, body, await this.bearer(), key); }
    catch (error) {
      if (!(error instanceof FiskalyTestError) || error.code !== 'AUTH') throw error;
      this.token = undefined;
      // Refresh once; every business request keeps its persisted idempotency key.
      return this.http(route, method, body, await this.bearer(), key);
    }
  }
  createRecord(body: unknown, key: string) { return this.authenticated('/records', 'POST', body, idempotencyKey.parse(key)); }
  getRecord(id: string) { return this.authenticated(`/records/${identifier.parse(id)}?compliance-artifact`, 'GET'); }
  getSystem(id: string) { return this.authenticated(`/systems/${identifier.parse(id)}`, 'GET'); }
  async preflight() {
    const systems = [];
    for (const binding of this.config.bindings) {
      const result = await this.getSystem(binding.systemId);
      const content = result?.content;
      if (content?.id !== binding.systemId || content?.type !== 'FISCAL_DEVICE') throw new FiskalyTestError('RESPONSE');
      systems.push({ registerId: binding.registerId, systemId: binding.systemId, commissioned: content.state === 'COMMISSIONED' });
    }
    return { environment: 'TEST', systems, saleActivationAllowed: false, notice: 'Åtkomstkontroll; ingen verifiering av svensk kontrollregistrering.' };
  }
}
