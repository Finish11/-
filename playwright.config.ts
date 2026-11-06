import { defineConfig, devices } from '@playwright/test';
import chromium, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// В CI/sandbox нет системных libnss/libnspr; пакет nesёт совместимые библиотеки AL2023.
const al2023 = resolve('node_modules/@sparticuz/chromium/bin/al2023.tar.br');
if (existsSync(al2023) && !existsSync('/tmp/al2023/lib/libnss3.so')) await inflate(al2023);
setupLambdaEnvironment('/tmp/al2023/lib');
const executablePath = await chromium.executablePath();
// single-process нестабилен при смене контекстов Playwright вне AWS Lambda.
const launchArgs = chromium.args.filter((arg) => arg !== '--single-process');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: { executablePath, args: launchArgs, env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib', FONTCONFIG_PATH: '/tmp/fonts' } },
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: 'npx tsx server/index.ts',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: '4173', DATA_DIR: '/tmp/pulsenet-e2e-data', VITE_DEMO: '1' },
  },
});
