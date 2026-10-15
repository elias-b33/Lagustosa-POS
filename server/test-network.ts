import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { demand } from './errors';

export function assertTestTransport(env: NodeJS.ProcessEnv, hasTls: boolean, localAddresses = Object.values(networkInterfaces()).flatMap(items => items?.map(item => item.address) ?? [])): boolean {
  const host = env.HOST || '127.0.0.1';
  const httpLan = env.SAFE_TEST_HTTP_LAN === '1';
  if (httpLan) {
    const [a, b] = host.split('.').map(Number);
    const privateAddress = isIP(host) === 4 && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
    demand(env.TEST_ENVIRONMENT === 'safe-test' && (env.APP_MODE ?? 'training') === 'training' && (env.PAYMENT_ADAPTER ?? 'simulator') === 'simulator' && (env.FISCAL_ADAPTER ?? 'simulator') === 'simulator', 'HTTP på hemnätet kräver en separat testmiljö med simulerade betalningar.', 500, 'HTTP_TEST_ONLY');
    demand(!hasTls && privateAddress && localAddresses.includes(host), 'HTTP-hemtestet måste bindas till datorns egen privata IPv4-adress utan TLS.', 500, 'HTTP_TEST_ADDRESS');
  }
  if (env.TEST_ENVIRONMENT === 'safe-test') {
    demand(hasTls || ['127.0.0.1', '::1', 'localhost'].includes(host) || httpLan, 'Testmiljön behöver HTTPS eller uttryckligt HTTP-hemtest för anslutningar från andra enheter.', 500, 'TEST_TLS_REQUIRED');
  }
  return httpLan;
}
