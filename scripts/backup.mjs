import { backupDatabase } from './database-tools.mjs';
try { console.log(`Säkerhetskopian är verifierad och sparad: ${await backupDatabase()}`); }
catch (error) { console.error(error.message); process.exitCode = 1; }
