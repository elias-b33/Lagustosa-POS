import { z } from 'zod';

export const FISKALY_TEST_ORIGIN = 'https://test.api.fiskaly.com';
export const FISKALY_API_VERSION = '2026-06-01';
const uuid = z.uuid({ version: 'v7' });
export const bindingSchema = z.object({ registerId: z.string().trim().min(1).max(72), systemId: uuid }).strict();
const configSchema = z.object({
  apiKey: z.string().min(1).max(512), apiSecret: z.string().min(1).max(512), unitId: uuid,
  bindings: z.array(bindingSchema).min(1).max(100),
}).strict().superRefine((config, context) => {
  if (new Set(config.bindings.map(binding => binding.registerId)).size !== config.bindings.length || new Set(config.bindings.map(binding => binding.systemId)).size !== config.bindings.length) {
    context.addIssue({ code: 'custom', message: 'Varje lokal kassa måste ha ett eget fiskaly-system.' });
  }
});
export type FiskalyTestConfig = z.infer<typeof configSchema>;
export function parseFiskalyTestConfig(value: unknown): FiskalyTestConfig {
  const result = configSchema.safeParse(value);
  // Do not expose secret-bearing validation input or vendor responses in errors.
  if (!result.success) throw new Error('Ogiltig fiskaly TEST-konfiguration. Kontrollera nycklar, organisation och unika kassakopplingar.');
  return result.data;
}
export function readFiskalyTestConfig(env: NodeJS.ProcessEnv): FiskalyTestConfig {
  if (env.FISKALY_BASE_URL && env.FISKALY_BASE_URL !== FISKALY_TEST_ORIGIN) throw new Error('Endast fiskalys TEST-adress tillåts.');
  let bindings: unknown;
  try { bindings = JSON.parse(env.FISKALY_TEST_BINDINGS ?? 'null'); } catch { throw new Error('Kassakopplingarna måste vara giltig JSON.'); }
  return parseFiskalyTestConfig({ apiKey: env.FISKALY_TEST_API_KEY, apiSecret: env.FISKALY_TEST_API_SECRET, unitId: env.FISKALY_TEST_UNIT_ID, bindings });
}
