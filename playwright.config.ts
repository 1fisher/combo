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
      command: 'bash scripts/dev-backend.sh 18236',
      url: 'http://127.0.0.1:18236/v1/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
