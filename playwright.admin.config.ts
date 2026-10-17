import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
const directory =
  process.env.ADMIN_TEST_DIR ??
  path.join(tmpdir(), `eleva-admin-e2e-${randomUUID()}`);
process.env.ADMIN_TEST_DIR = directory;
export default defineConfig({
  testDir: "tests/admin-browser",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  outputDir: "test-results/admin",
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/admin-playwright", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5384",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx tests/fixtures/admin-server.ts",
    url: "http://127.0.0.1:5384/",
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      ADMIN_LOCAL_DIR: directory,
      ADMIN_LOCAL_PORT: "5384",
      APP_MODE: "training",
      PAYMENT_ADAPTER: "simulator",
      PRINT_ADAPTER: "preview",
      FISCAL_ADAPTER: "simulator",
      INSTALLATION_PROFILE: "restaurant",
    },
  },
});
