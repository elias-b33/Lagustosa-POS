export interface BackupInspection { bytes: number; sha256: string; journalEntries: number; journalHead: string }
export function inspectBackup(filename: string): BackupInspection;
export function sealBackup(filename: string, createdAt?: string): BackupInspection & { format: string; version: number; mode: string; createdAt: string };
export function verifyBackupManifest(filename: string, allowLegacy?: boolean): BackupInspection & { legacy: boolean };
