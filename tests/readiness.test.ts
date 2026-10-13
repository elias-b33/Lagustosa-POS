import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const { app } of apps.splice(0)) await app.close(); });

describe('Database readiness', () => {
  it('checks the database without changing restaurant data or requiring a staff session', async () => {
    const context = await createApp({ database: ':memory:' }); apps.push(context);
    const before = context.store.db.prepare('SELECT total_changes() AS n').get();
    const response = await context.app.inject('/api/v1/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, mode: 'training', checks: { databaseRead: 'ok' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(context.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('reports unavailable when the process responds but the data schema cannot be read', async () => {
    const context = await createApp({ database: ':memory:' }); apps.push(context);
    // Deliberate corruption is confined to this in-memory test database.
    context.store.db.exec('DROP TABLE entities');
    expect((await context.app.inject('/api/v1/health')).statusCode).toBe(200);
    const response = await context.app.inject('/api/v1/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, mode: 'training', checks: { databaseRead: 'unavailable' } });
    expect(response.body).not.toContain('entities');
  });
});
