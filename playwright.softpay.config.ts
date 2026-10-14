import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/softpay-browser', workers: 1, fullyParallel: false, timeout: 45000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/softpay' }]],
  use: { baseURL: 'http://127.0.0.1:4193', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }],
  webServer: { command: 'npx tsx tests/fixtures/softpay-server.ts', url: 'http://127.0.0.1:4193/api/v1/health', reuseExistingServer: false, env: { SOFTPAY_CONTRACT_PORT: '4193' } },
});
