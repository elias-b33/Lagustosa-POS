import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { demand } from './errors';
import type { SoftpayCredentials } from './softpay-client';

export const softpayTerminalsSchema = z.array(z.object({
  deviceId: z.string().trim().min(1).max(100), appId: z.string().regex(/^[A-Z]{3}[0-9]{10}$/), storeId: z.number().int().positive().safe(),
}).strict()).min(1).max(100).refine(rows => new Set(rows.map(row => row.deviceId)).size === rows.length && new Set(rows.map(row => row.appId)).size === rows.length, 'Varje kassa och Softpay-app får bara ha en koppling.');
export type SoftpayTerminal = z.infer<typeof softpayTerminalsSchema>[number];
export interface SoftpaySandboxConfig extends SoftpayCredentials { terminals: SoftpayTerminal[] }

export function readSoftpaySandboxConfig(env: NodeJS.ProcessEnv): SoftpaySandboxConfig {
  const credentials = z.object({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(4096), merchantReference: z.uuid().optional() }).safeParse({
    clientId: env.SOFTPAY_SANDBOX_CLIENT_ID, clientSecret: env.SOFTPAY_SANDBOX_CLIENT_SECRET, merchantReference: env.SOFTPAY_SANDBOX_MERCHANT_REFERENCE || undefined,
  });
  demand(credentials.success && env.SOFTPAY_SANDBOX_TERMINALS_FILE, 'Softpay sandbox behöver serverns klient-id, klienthemlighet och en fil med enhetskopplingar.', 500, 'SOFTPAY_CONFIG');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(env.SOFTPAY_SANDBOX_TERMINALS_FILE!, 'utf8')); }
  catch { throw new Error('Softpay sandbox: enhetsfilen kunde inte läsas.'); }
  const terminals = softpayTerminalsSchema.safeParse(raw);
  demand(terminals.success, 'Softpay sandbox: enhetsfilen måste ha unika kassa-id/appId och giltiga storeId.', 500, 'SOFTPAY_CONFIG');
  return { ...credentials.data, terminals: terminals.data };
}
