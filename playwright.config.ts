import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    env: { PORT: '4183', HOST: '127.0.0.1', DATA_DIR: path.join(tmpdir(), `lagustosa-e2e-${randomUUID()}`), APP_MODE: 'training', TLS_CERT: '', TLS_KEY: '' },
  },
});
