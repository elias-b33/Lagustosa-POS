import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Ange serverns HTTP(S)-adress utan inloggningsuppgifter, sökväg eller parametrar.');
  }
  return url.origin;
}

// Read-only probes. Never submit a sale or ignore a failed TLS certificate.
export async function probeAvailability(baseUrl, timeoutMs = 3000) {
  const base = normalizeBaseUrl(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Tidsgränsen måste vara ett heltal mellan 1 och 2147483647 millisekunder.');
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const check = async (endpoint, validate) => {
    try {
      const response = await fetch(base + endpoint, { signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) { await response.body?.cancel(); return false; }
      return await validate(response);
    } catch { return false; }
  };
  const [databaseRead, webPage] = await Promise.all([
    check('/api/v1/ready', async response => {
      const data = await response.json();
      return data.ok === true && data.mode === 'training' && data.checks?.databaseRead === 'ok';
    }),
    check('/', async response => {
      if (!response.headers.get('content-type')?.includes('text/html')) return false;
      const html = await response.text();
      return html.includes('<title>Lagustosa Kassa</title>') && /id=["']root["']/.test(html);
    }),
  ]);
  return { available: databaseRead && webPage, databaseRead, webPage, latencyMs: Math.round(performance.now() - started) };
}

// Treat gaps in monitoring conservatively as unverified, never as successful uptime.
// Each observation covers at most two probe intervals; shorter outages between
// observations are not detectable. This is a sampled service probe, not an SLA.
export function availabilityReport(samples, durationMs, intervalMs, targetPercent = 99) {
  let availableMs = 0;
  let unavailableMs = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const next = samples[index + 1]?.elapsedMs ?? durationMs;
    const covered = Math.max(0, Math.min(next, durationMs, sample.elapsedMs + 2 * intervalMs) - sample.elapsedMs);
    if (sample.available) availableMs += covered;
    else unavailableMs += covered;
  }
  const unverifiedMs = Math.max(0, durationMs - availableMs - unavailableMs);
  const estimatedAvailabilityPercent = durationMs > 0 ? availableMs / durationMs * 100 : null;
  return {
    type: 'summary', scope: 'training-api-database-read-and-web-page', targetPercent,
    durationMs: Math.round(durationMs), availableMs: Math.round(availableMs), unavailableMs: Math.round(unavailableMs), unverifiedMs: Math.round(unverifiedMs),
    samples: samples.length, failedSamples: samples.filter(sample => !sample.available).length,
    estimatedAvailabilityPercent, targetMetInObservedWindow: estimatedAvailabilityPercent !== null && estimatedAvailabilityPercent >= targetPercent,
    limitations: 'Stickprov i angivet mätfönster. Verifierar inte JavaScript/CSS, rendering, användarinteraktion, inloggning, skrivningar, fysisk utrustning, bankbetalningar eller framtida tillgänglighet. Omätade tider utanför körningen ingår inte.',
  };
}

export async function measureAvailability({ baseUrl, durationMs, intervalMs, timeoutMs, output }) {
  const base = normalizeBaseUrl(baseUrl);
  if (![durationMs, intervalMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) || intervalMs > 2147483647 || timeoutMs > 2147483647) throw new Error('Mättiderna måste vara positiva heltal i millisekunder; intervall och tidsgräns får vara högst 2147483647.');
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ type: 'start', at: new Date().toISOString(), baseUrl: base, durationMs, intervalMs, timeoutMs, targetPercent: 99 }) + '\n', { flag: 'wx' });
  const started = performance.now();
  const samples = [];
  while (performance.now() - started < durationMs) {
    const elapsedMs = performance.now() - started;
    const result = await probeAvailability(base, Math.max(1, Math.min(timeoutMs, Math.floor(durationMs - elapsedMs))));
    const sample = { type: 'sample', at: new Date().toISOString(), elapsedMs, ...result };
    samples.push(sample);
    appendFileSync(output, JSON.stringify(sample) + '\n');
    const untilNext = Math.min(intervalMs - (performance.now() - started - elapsedMs), durationMs - (performance.now() - started));
    if (untilNext > 0) await delay(untilNext);
  }
  const report = { ...availabilityReport(samples, durationMs, intervalMs), finishedAt: new Date().toISOString() };
  appendFileSync(output, JSON.stringify(report) + '\n');
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--url', '--seconds', '--interval-ms', '--timeout-ms', '--output'].includes(flag) || options[flag] !== undefined) throw new Error(`Okänt eller upprepat argument: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Värde saknas för ${flag}`);
    options[flag] = value;
  }
  if (!options['--url'] || !options['--output']) throw new Error('Använd --url http://SERVER:PORT --seconds 3600 --output artifacts/availability.jsonl. Starta under öppettid och ange ett mätfönster inom öppettiderna.');
  const report = await measureAvailability({ baseUrl: options['--url'], output: options['--output'], durationMs: Number(options['--seconds'] ?? 60) * 1000, intervalMs: Number(options['--interval-ms'] ?? 5000), timeoutMs: Number(options['--timeout-ms'] ?? 3000) });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.targetMetInObservedWindow) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
