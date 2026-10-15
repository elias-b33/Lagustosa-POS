import { describe, expect, it } from 'vitest';
import { assertTestTransport } from '../server/test-network';

const localAddresses = ['127.0.0.1', '192.168.1.50'];
const env = { APP_MODE: 'training', TEST_ENVIRONMENT: 'safe-test', HOST: '192.168.1.50', PAYMENT_ADAPTER: 'simulator', FISCAL_ADAPTER: 'simulator' };

describe('Explicit HTTP home test', () => {
  it('keeps HTTPS mandatory on the LAN unless the home-test flag is set', () => {
    expect(() => assertTestTransport(env, false, localAddresses)).toThrow('HTTPS');
    expect(assertTestTransport(env, true, localAddresses)).toBe(false);
    expect(assertTestTransport({ ...env, HOST: '127.0.0.1' }, false, localAddresses)).toBe(false);
    expect(assertTestTransport({ ...env, SAFE_TEST_HTTP_LAN: '1' }, false, localAddresses)).toBe(true);
  });
  it.each(['0.0.0.0', '127.0.0.1', '8.8.8.8', '192.168.1.51', '192.168.01.50', 'localhost'])('rejects a wildcard, public, non-local or invalid binding: %s', host => {
    expect(() => assertTestTransport({ ...env, HOST: host, SAFE_TEST_HTTP_LAN: '1' }, false, localAddresses)).toThrow('egen privata IPv4');
  });
  it.each([
    { APP_MODE: 'production' }, { TEST_ENVIRONMENT: '' }, { PAYMENT_ADAPTER: 'live' },
    { PAYMENT_ADAPTER: 'softpay-sandbox' }, { FISCAL_ADAPTER: 'live' },
  ])('rejects non-test configurations: %j', override => {
    expect(() => assertTestTransport({ ...env, ...override, SAFE_TEST_HTTP_LAN: '1' }, false, localAddresses)).toThrow('separat testmiljö');
  });
  it('rejects mixed HTTP and TLS settings', () => {
    expect(() => assertTestTransport({ ...env, SAFE_TEST_HTTP_LAN: '1' }, true, localAddresses)).toThrow('utan TLS');
  });
});
