import {defineConfig} from '@playwright/test'

// Needs a local validator with the program deployed: see scripts/e2e.sh.
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: {timeout: 30_000},
  workers: 1,
  use: {baseURL: 'http://127.0.0.1:5173', launchOptions: {executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome'}, screenshot: 'only-on-failure'},
  webServer: {command: 'npx vite --config web/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort', cwd: '..', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000},
})
