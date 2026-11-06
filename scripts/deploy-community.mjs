#!/usr/bin/env node
/** Деплой общего API в Cloudflare Workers + D1. Секреты только из окружения/GitHub Secrets. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const NAME = 'pulsenet-community';
const configPath = resolve('community/wrangler.toml');
const deployConfigPath = resolve('community/.wrangler-deploy.toml');
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error('Нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID. Без них деплой не выполняется.');
  process.exit(1);
}
function wrangler(args, { capture = false } = {}) {
  const result = spawnSync('npx', ['--no', 'wrangler', ...args], {
    encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || '');
    throw new Error(`wrangler ${args.join(' ')} завершился с кодом ${result.status}`);
  }
  return capture ? result.stdout : '';
}
function listDatabase() {
  const raw = wrangler(['d1', 'list', '--json'], { capture: true });
  const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Не удалось разобрать wrangler d1 list --json');
  const rows = JSON.parse(raw.slice(start, end + 1));
  return rows.find((row) => row.name === NAME || row.database_name === NAME);
}
try {
  let database = listDatabase();
  if (!database) {
    console.log(`Создаём D1 ${NAME}…`);
    wrangler(['d1', 'create', NAME, '--binding', 'DB']);
    database = listDatabase();
  }
  const id = database?.uuid || database?.database_id || database?.id;
  if (!id) throw new Error('D1 создана, но её UUID не найден в выводе wrangler');
  const template = readFileSync(configPath, 'utf8');
  writeFileSync(deployConfigPath, template.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`));
  console.log('Применяем миграции D1…');
  wrangler(['d1', 'migrations', 'apply', NAME, '--remote', '--config', deployConfigPath]);
  console.log('Публикуем Worker…');
  const output = wrangler(['deploy', '--config', deployConfigPath], { capture: true });
  process.stdout.write(output);
  const match = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i);
  if (!match) throw new Error('Worker опубликован, но URL не найден в выводе Wrangler. Проверьте Cloudflare Dashboard.');
  const url = match[0].replace(/\/+$/, '');
  const health = await fetch(`${url}/api/community/health`, { signal: AbortSignal.timeout(15000) });
  const data = await health.json();
  if (!health.ok || data?.service !== NAME || data?.ok !== true) throw new Error(`Health-check не пройден: HTTP ${health.status}`);
  console.log(`\nГотово. Публичный API: ${url}`);
  console.log('Задайте PULSENET_COMMUNITY_API_URL в GitHub Variables или подключите этот адрес в «Сбои» на устройствах.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(deployConfigPath, { force: true });
}
