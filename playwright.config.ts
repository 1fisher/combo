import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'bash scripts/dev-proxy.sh',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'cargo run -p combo-proxy --bin combo-proxy -- --port 18234',
      url: 'http://127.0.0.1:18234/v1/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
