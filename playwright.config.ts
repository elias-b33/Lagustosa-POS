import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = path.join(tmpdir(), `lagustosa-e2e-${randomUUID()}`);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4183', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 980 } } }],
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:4183/api/v1/health',
    reuseExistingServer: false,
    env: { PORT: '4183', HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, 'backups'), APP_MODE: 'training', PAYMENT_ADAPTER: 'simulator', FISCAL_ADAPTER: 'simulator', PRINT_ADAPTER: 'preview', TLS_CERT: '', TLS_KEY: '', SESSION_COOKIE_NAME: 'lagustosa_safe_test_e2e', TEST_ENVIRONMENT: 'safe-test', TEST_INSTANCE_ID: randomUUID(), TEST_LAUNCH_ID: randomUUID(), TEST_SESSION_ID: randomUUID(), NODE_ENV: 'production' },
  },
});
