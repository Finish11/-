import chromium, { inflate, setupLambdaEnvironment } from '@sparticuz/chromium';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Chromium для песочницы и CI.
 *
 * В образе нет системных libnss/libnspr, поэтому берём сборку AL2023 из
 * `@sparticuz/chromium`. Тот же запуск использует playwright.config.ts —
 * эмулятор телефона должен видеть ту же среду, что и сквозные тесты.
 * `--single-process` нестабилен при смене контекстов вне AWS Lambda.
 */
export async function chromiumLaunch(): Promise<{
  executablePath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}> {
  const al2023 = resolve('node_modules/@sparticuz/chromium/bin/al2023.tar.br');
  if (existsSync(al2023) && !existsSync('/tmp/al2023/lib/libnss3.so')) await inflate(al2023);
  setupLambdaEnvironment('/tmp/al2023/lib');
  const executablePath = await chromium.executablePath();
  return {
    executablePath,
    args: chromium.args.filter((arg) => arg !== '--single-process'),
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib', FONTCONFIG_PATH: '/tmp/fonts' },
  };
}
