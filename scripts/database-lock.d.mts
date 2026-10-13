export function acquireDatabaseLock(dataDir: string, purpose?: 'server' | 'restore'): () => void;
