/** Server-side TEST access check. Credentials come only from the environment.
 * npx tsx scripts/fiskaly-test-check.ts            (offline config check)
 * npx tsx scripts/fiskaly-test-check.ts --connect  (authenticate + GET systems)
 * Never creates/commissions systems, issues receipts or activates the POS.
 */
import { readFiskalyTestConfig } from '../server/fiskaly-test/config';
import { FiskalyTestClient } from '../server/fiskaly-test/client';

try {
  if (process.argv.slice(2).some(argument => argument !== '--connect')) throw new Error('Använd endast --connect för att kontrollera TEST-åtkomst.');
  const config = readFiskalyTestConfig(process.env);
  if (process.argv.includes('--connect')) console.log(JSON.stringify(await new FiskalyTestClient(config).preflight(), null, 2));
  else console.log(JSON.stringify({ environment: 'TEST', configuredRegisters: config.bindings.length, networkUsed: false, saleActivationAllowed: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Konfigurationen kunde inte kontrolleras.'); process.exitCode = 1;
}
