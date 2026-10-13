import { restoreDatabase } from './database-tools.mjs';
try {
  const result = await restoreDatabase(process.argv[2]);
  console.log(`Träningsdatabasen är återställd: ${result.database}`);
  if (result.safetyBackup) console.log(`Databasen före återställningen finns kvar: ${result.safetyBackup}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
