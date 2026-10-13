import { restoreDatabase } from './database-tools.mjs';
try {
  const result = await restoreDatabase(process.argv[2], undefined, { allowLegacy: process.argv.slice(3).includes('--allow-legacy') });
  console.log(`Träningsdatabasen är återställd: ${result.database}`);
  if (result.safetyBackup) console.log(`Databasen före återställningen finns kvar: ${result.safetyBackup}`);
  console.log('Tidigare sessioner är avslutade. Logga in på nytt på samtliga enheter.');
  if (result.legacyManifest) console.log('Äldre kopia utan manifest: endast databas och intern journal har verifierats.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
