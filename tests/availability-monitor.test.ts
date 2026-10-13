import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Standalone Node CLI shared with operational use.
import { availabilityReport, measureAvailability, normalizeBaseUrl, probeAvailability } from '../scripts/measure-availability.mjs';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
async function endpoint(mode: 'ok' | 'database-failed' | 'wrong-page' | 'hung' | 'hung-body') {
  const server = createServer((request, response) => {
    if (mode === 'hung') return;
    if (mode === 'hung-body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
    if (request.url === '/api/v1/ready') {
      response.writeHead(mode === 'database-failed' ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, mode: 'training', checks: { databaseRead: 'ok' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(mode === 'wrong-page' ? '<h1>Other service</h1>' : '<title>Lagustosa Kassa</title><div id="root"></div>');
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}`;
}

describe('Availability measurement', () => {
  it('requires both readable data and the expected application page', async () => {
    expect(await probeAvailability(await endpoint('ok'))).toMatchObject({ available: true, databaseRead: true, webPage: true });
    expect(await probeAvailability(await endpoint('database-failed'))).toMatchObject({ available: false, databaseRead: false });
    expect(await probeAvailability(await endpoint('wrong-page'))).toMatchObject({ available: false, webPage: false });
  });

  it('bounds a hung request instead of counting silence as availability', async () => {
    const started = performance.now();
    expect(await probeAvailability(await endpoint('hung'), 60)).toMatchObject({ available: false });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('also bounds a response that sends headers but never finishes its body', async () => {
    const started = performance.now();
    expect(await probeAvailability(await endpoint('hung-body'), 60)).toMatchObject({ available: false });
    expect(performance.now() - started).toBeLessThan(2000);
    await expect(probeAvailability('http://127.0.0.1:4173', 1.5)).rejects.toThrow('heltal');
  });

  it('counts failed probes and unobserved gaps against the target using elapsed time', () => {
    const report = availabilityReport([
      { elapsedMs: 0, available: true },
      { elapsedMs: 1000, available: false },
      { elapsedMs: 5000, available: true },
    ], 6000, 1000);
    expect(report).toMatchObject({ availableMs: 2000, unavailableMs: 2000, unverifiedMs: 2000, targetMetInObservedWindow: false });
    expect(report.estimatedAvailabilityPercent).toBeCloseTo(100 / 3);
    expect(availabilityReport([], 6000, 1000)).toMatchObject({ unverifiedMs: 6000, estimatedAvailabilityPercent: 0, targetMetInObservedWindow: false });
  });

  it('does not permit credentials or an unrelated path in the measurement address', () => {
    expect(normalizeBaseUrl('https://restaurant.local:4173/')).toBe('https://restaurant.local:4173');
    expect(() => normalizeBaseUrl('https://admin:secret@restaurant.local')).toThrow();
    expect(() => normalizeBaseUrl('https://restaurant.local/other')).toThrow();
  });

  it('writes a complete bounded observation log and refuses to overwrite previous evidence', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lagustosa-monitor-'));
    const output = path.join(directory, 'observations.jsonl');
    try {
      const options = { baseUrl: await endpoint('ok'), durationMs: 300, intervalMs: 50, timeoutMs: 100, output };
      const result = await measureAvailability(options);
      const original = readFileSync(output, 'utf8');
      const entries = original.trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).toMatchObject({ type: 'start', durationMs: 300 });
      expect(entries.at(-1)).toEqual(result);
      expect(entries.filter(entry => entry.type === 'sample').length).toBe(result.samples);
      expect(result.samples).toBeGreaterThan(0);
      expect(result.scope).toBe('training-api-database-read-and-web-page');
      await expect(measureAvailability(options)).rejects.toThrow();
      expect(readFileSync(output, 'utf8')).toBe(original);
    } finally {
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('lagustosa-monitor-')) throw new Error('Unsafe cleanup');
      rmSync(resolved, { recursive: true, force: true });
    }
  });
});
