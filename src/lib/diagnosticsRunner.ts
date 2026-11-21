/**
 * Самопроверка всех подсистем: сеть, сайты, скорость, YouTube, VPN, хранение.
 * Результат — массив шагов с статусом и копируемые логи. Каждый шаг изолирован:
 * отказ одного не валит остальные, а лог пишется сразу, чтобы «зависший» шаг
 * было видно по таймауту.
 */

import { logInfo, logWarn, logError } from './appLogger';
import { ApkUpdater, checkForUpdateResult } from './appUpdate';
import { getNativeNetworkState, getVpnDiagnostics, httpProbe, isNativeApp, ipEcho, realDelayProbe } from './nativeBridge';
import { probeControl } from './siteProbe';
import { detectNetworkContext } from './networkInfo';
import { availableSpeedServers, pickSpeedServer } from './speedEndpoints';
import { communityEndpoint } from './community';
import { apiFetch } from './api';

export type DiagStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'running';
export interface DiagStep {
  id: string;
  title: string;
  hint: string;
  status: DiagStatus;
  message: string;
  detail?: string;
  ms?: number;
}

export interface DiagReport {
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  native: boolean;
  steps: DiagStep[];
}

export type DiagProgress = (report: DiagReport) => void;

function step(id: string, title: string, hint: string, status: DiagStatus = 'running', message = 'Выполняется…'): DiagStep {
  return { id, title, hint, status, message };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(onTimeout)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function runDiagnostics(onProgress?: DiagProgress, signal?: AbortSignal): Promise<DiagReport> {
  const started = Date.now();
  const report: DiagReport = {
    startedAt: new Date(started).toISOString(),
    native: isNativeApp(),
    steps: [],
  };
  const push = (s: DiagStep) => { report.steps.push(s); onProgress?.({ ...report, steps: [...report.steps] }); };
  const update = (id: string, patch: Partial<DiagStep>) => {
    const idx = report.steps.findIndex((s) => s.id === id);
    if (idx >= 0) {
      report.steps[idx] = { ...report.steps[idx], ...patch };
      onProgress?.({ ...report, steps: [...report.steps] });
    }
  };

  logInfo('diag', 'Самопроверка запущена', `native=${isNativeApp()} endpoint=${communityEndpoint() || '—'}`);

  // 1. Базовая сеть
  {
    const id = 'network';
    push(step(id, 'Сеть и IP', 'Определяем тип подключения и внешний адрес'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const nativeState = isNativeApp() ? await withTimeout(getNativeNetworkState(), 5000, 'native network timeout 5s') : null;
      const ctx = await withTimeout(detectNetworkContext({ skipGeo: false }), 12000, 'detectNetworkContext timeout 12s');
      const detail = [
        `kind=${ctx.networkKind} vpn=${ctx.appUsesVpn ?? ctx.vpnLikely} ip=${ctx.geo?.ip || '—'} isp=${ctx.geo?.isp || '—'}`,
        nativeState ? `carrier=${nativeState.carrier || '—'} systemVpn=${nativeState.systemVpn} appUsesVpn=${nativeState.appUsesVpn}` : 'nativeState: n/a (браузер)',
      ].join('\n');
      const ok = Boolean(ctx.geo?.ip || nativeState?.connected);
      update(id, { status: ok ? 'ok' : 'warn', message: ok ? `IP ${ctx.geo?.ip || 'не определён'} · ${ctx.geo?.isp || ctx.networkKind}` : 'Сеть не определена', detail, ms: Date.now() - t0 });
      logInfo('diag', `Сеть: ${ok ? 'ok' : 'warn'}`, detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: `Сеть: ${msg}`, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Сеть: fail', msg);
    }
  }

  // 2. VPN-диагностика
  {
    const id = 'vpn';
    push(step(id, 'VPN-клиент', 'Проверяем, идёт ли трафик через туннель (только в APK)'));
    const t0 = Date.now();
    try {
      if (!isNativeApp()) {
        update(id, { status: 'skip', message: 'Пропущено: доступно только в приложении', ms: Date.now() - t0 });
      } else {
        if (signal?.aborted) throw new Error('Отменено');
        const diag = await withTimeout(getVpnDiagnostics(), 6000, 'vpnDiagnostics timeout 6s');
        if (!diag.ok && diag.error) throw new Error(diag.error);
        const detail = `appUsesVpn=${diag.appUsesVpn} systemVpn=${diag.systemVpn} splitTunnel=${diag.splitTunnel} locking=${diag.lockdown} pkg=${diag.vpnPackage || '—'}`;
        const status: DiagStatus = diag.appUsesVpn || !diag.systemVpn ? 'ok' : 'warn';
        update(id, { status, message: diag.appUsesVpn ? `VPN ${diag.vpnAppName || diag.vpnPackage} — трафик идёт через туннель` : diag.systemVpn ? 'VPN включён, но приложение идёт мимо (раздельный туннель)' : 'VPN не включён', detail, ms: Date.now() - t0 });
        logInfo('diag', `VPN: ${status}`, detail);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: `VPN: ${msg}`, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'VPN fail', msg);
    }
  }

  // 3. IP-эхо (проверка обхода туннеля)
  {
    const id = 'ip-echo';
    push(step(id, 'Внешний IP эхо', 'Сравниваем IP напрямую и через систему'));
    const t0 = Date.now();
    try {
      if (!isNativeApp()) {
        update(id, { status: 'skip', message: 'Пропущено: только в APK', ms: Date.now() - t0 });
      } else {
        if (signal?.aborted) throw new Error('Отменено');
        const direct = await withTimeout(ipEcho(true, 6000), 7000, 'ipEcho bypass timeout');
        const active = await withTimeout(ipEcho(false, 6000), 7000, 'ipEcho active timeout');
        const detail = `bypass=${direct.ok ? direct.ip : direct.error} active=${active.ok ? active.ip : active.error}`;
        const bothOk = direct.ok && active.ok;
        const same = bothOk && direct.ip === active.ip;
        update(id, {
          status: !bothOk ? 'warn' : same && !direct.ip ? 'warn' : 'ok',
          message: bothOk ? (same ? `IP совпадает: ${active.ip} — туннель ${direct.ip === active.ip && (await getVpnDiagnostics()).appUsesVpn ? 'не обходится' : 'возможно обходится'}` : `Разные IP: напрямую ${direct.ip}, активно ${active.ip}`) : `Частично: ${detail}`,
          detail, ms: Date.now() - t0 });
        logInfo('diag', `IP echo ${bothOk ? 'ok' : 'warn'}`, detail);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'IP echo fail', msg);
    }
  }

  // 4. Контрольная проба сети (generate_204)
  {
    const id = 'control';
    push(step(id, 'Связь с интернетом', 'Контрольная проба generate_204 (Google/Cloudflare/Ya)'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const ok = await withTimeout(probeControl(6000), 8000, 'probeControl timeout 8s');
      update(id, { status: ok ? 'ok' : 'fail', message: ok ? 'Контрольные адреса отвечают' : 'Контрольные адреса не отвечают — проверьте интернет', ms: Date.now() - t0 });
      logInfo('diag', `Control probe ${ok ? 'ok' : 'fail'}`);
      if (!ok) logWarn('diag', 'Контрольная проба не прошла — сайты и скорость могут врать');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Control fail', msg);
    }
  }

  // 5. Проба одного сайта
  {
    const id = 'site-probe';
    push(step(id, 'Проба сайта', 'Запрашиваем rbc.ru через нативный HTTP'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const url = 'https://www.rbc.ru/favicon.ico';
      const res = await withTimeout(httpProbe(url, 8000), 9000, 'httpProbe timeout 9s');
      const detail = `ok=${res.ok} status=${res.status} err=${res.error || '—'} truncated=${res.truncated} ct=${res.content_type}`;
      const status: DiagStatus = res.ok && res.status && res.status >= 200 && res.status < 400 ? 'ok' : res.status === 403 ? 'warn' : 'fail';
      update(id, { status, message: res.ok ? `Ответ ${res.status} · ${res.content_type || 'без типа'}` : `Ошибка: ${res.error}`, detail, ms: Date.now() - t0 });
      logInfo('diag', `Site probe ${status}`, detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Site probe fail', msg);
    }
  }

  // 6. Серверы скорости
  {
    const id = 'speed-servers';
    push(step(id, 'Точки замера скорости', 'Ищем доступные серверы (свой/Cloudflare)'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const servers = availableSpeedServers({ communityEndpoint: communityEndpoint() || undefined });
      const detail = servers.map((s) => `${s.id}:${s.label}`).join('\n') || 'нет серверов';
      // Пробуем выбрать лучший — это и есть проверка доступности пинга
      if (servers.length === 0) {
        update(id, { status: 'fail', message: 'Нет доступных серверов', detail, ms: Date.now() - t0 });
        logError('diag', 'No speed servers');
      } else {
        update(id, { status: 'ok', message: `Найдено точек: ${servers.length}`, detail, ms: Date.now() - t0 });
        logInfo('diag', `Speed servers ${servers.length}`, detail);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Speed servers fail', msg);
    }
  }

  // 7. Хранилище API
  {
    const id = 'api';
    push(step(id, 'Сервер приложения', 'Проверяем /api/sites и /api/auth/me'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const me = await withTimeout(apiFetch<{ user: { name: string } }>('/api/auth/me'), 6000, 'auth/me timeout');
      const sites = await withTimeout(apiFetch<{ sites: unknown[] }>('/api/sites'), 6000, '/api/sites timeout');
      const detail = `user=${(me as any).user?.name || '—'} sites=${(sites as any).sites?.length ?? 0}`;
      update(id, { status: 'ok', message: `API отвечает · сайтов ${Array.isArray((sites as any).sites) ? (sites as any).sites.length : '—'}`, detail, ms: Date.now() - t0 });
      logInfo('diag', 'API ok', detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: `API: ${msg}`, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'API fail', msg);
    }
  }

  // 8. Обновление приложения и права установки
  //    Самый частый баг обновления: APK скачался, но установщик не открылся
  //    (file:// или отсутствие разрешения). Поэтому проверяем не просто «есть
  //    обновление», а и то, можно ли его вообще запустить в этом устройстве.
  {
    const id = 'update';
    push(step(id, 'Обновление приложения', 'Проверка релиза и права на установку APK'));
    const t0 = Date.now();
    try {
      if (!isNativeApp()) {
        update(id, { status: 'skip', message: 'Пропущено: обновление доступно только в APK', ms: Date.now() - t0 });
      } else {
        if (signal?.aborted) throw new Error('Отменено');
        // Право на установку из этого источника — сразу и без сети.
        let canInstall: boolean | null = null;
        try {
          const perm = await withTimeout(ApkUpdater.getPermissionState(), 3000, 'getPermissionState timeout 3s');
          canInstall = Boolean(perm.canInstall);
        } catch (e) {
          update(id, { status: 'warn', message: `Права установки не получены: ${e instanceof Error ? e.message : e}`, ms: Date.now() - t0 });
        }
        // Проверка релиза: либо есть обновление, либо понятная причина.
        const result = await withTimeout(checkForUpdateResult(), 15000, 'update check timeout 15s');
        if (result.update) {
          const detail = `текущая ${result.update.currentVersion} → ${result.update.version} · ${result.update.sizeMb} МБ · canInstall=${canInstall ?? '—'}`;
          const status: DiagStatus = canInstall === false ? 'warn' : 'ok';
          const message = canInstall === false
            ? `Доступна ${result.update.version}, но для установки нужно разрешение «Установка неизвестных приложений»`
            : `Доступна ${result.update.version} (${result.update.sizeMb} МБ) · установка возможна`;
          update(id, { status, message, detail, ms: Date.now() - t0 });
          logInfo('diag', `Update ${status}: ${result.update.version}`, detail);
          if (canInstall === false) logWarn('diag', 'Нужно разрешение на установку приложений', detail);
        } else {
          const detail = `reason=${result.reason || '—'} canInstall=${canInstall ?? '—'}`;
          const status: DiagStatus = result.reason === 'network' || result.reason === 'rate-limit' ? 'warn' : 'ok';
          update(id, {
            status,
            message: result.reason === 'up-to-date' ? `Установлена последняя версия (${canInstall === false ? 'разрешение на установку не выдано' : 'установка возможна'})` : `Нет обновления: ${result.message || result.reason}`,
            detail, ms: Date.now() - t0,
          });
          logInfo('diag', `Update ${status}: ${result.reason || 'up-to-date'}`, detail);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: `Обновление: ${msg}`, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Update fail', msg);
    }
  }

  // 9. RealDelay сквозь туннель
  {
    const id = 'real-delay';
    push(step(id, 'Задержка через туннель', 'HTTP 204 сквозь активное подключение (real delay)'));
    const t0 = Date.now();
    try {
      if (!isNativeApp()) {
        update(id, { status: 'skip', message: 'Пропущено: только в APK', ms: Date.now() - t0 });
      } else {
        if (signal?.aborted) throw new Error('Отменено');
        const res = await withTimeout(realDelayProbe(undefined, 6000, 3), 8000, 'realDelay timeout 8s');
        const detail = `ok=${res.ok} latency=${res.latency_ms} err=${res.error || '—'} route=${res.route || '—'}`;
        update(id, { status: res.ok ? 'ok' : 'warn', message: res.ok ? `${Math.round(res.latency_ms ?? 0)} мс · ${res.route || 'маршрут'}` : `Не измерена: ${res.error || 'нет ответа'}`, detail, ms: Date.now() - t0 });
        logInfo('diag', `RealDelay ${res.ok ? 'ok' : 'warn'}`, detail);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'RealDelay fail', msg);
    }
  }

  // 10. YouTube пинг (лёгкий, без качки байт)
  {
    const id = 'youtube-ping';
    push(step(id, 'YouTube: доступность', 'Пинг youtube.com и googlevideo'));
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('Отменено');
      const { defaultTransport } = await import('./speedRunner');
      const transport = defaultTransport();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const y1 = await transport.latency('https://www.youtube.com/generate_204', 2, ctrl.signal as any, 4000).catch(() => ({ samples: [] as number[], error: 'no reply' }));
      const y2 = await transport.latency('https://redirector.googlevideo.com/generate_204', 1, ctrl.signal as any, 4000).catch(() => ({ samples: [] as number[], error: 'no reply' }));
      clearTimeout(timer);
      const detail = `youtube=${y1.samples.length ? y1.samples.map((n) => Math.round(n)).join(',') + 'ms' : y1.error} | googlevideo=${y2.samples.length ? y2.samples.map((n) => Math.round(n)).join(',') + 'ms' : y2.error}`;
      const anyOk = y1.samples.length > 0 || y2.samples.length > 0;
      update(id, { status: anyOk ? 'ok' : 'warn', message: anyOk ? 'YouTube отвечает' : 'YouTube не отвечает (таймаут) — проверьте VPN', detail, ms: Date.now() - t0 });
      logInfo('diag', `YouTube ping ${anyOk ? 'ok' : 'warn'}`, detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'YouTube ping fail', msg);
    }
  }

  // 11. LocalStorage / память
  {
    const id = 'storage';
    push(step(id, 'Хранилище', 'Проверяем localStorage и память отзывов'));
    const t0 = Date.now();
    try {
      const keys = Object.keys(localStorage);
      const pending = localStorage.getItem('pulsenet.speed_pending');
      const detail = `keys=${keys.length} pending=${pending ? JSON.parse(pending).length : 0} keys:${keys.slice(0, 6).join(',')}`;
      update(id, { status: 'ok', message: `Ключей в storage: ${keys.length}`, detail, ms: Date.now() - t0 });
      logInfo('diag', 'Storage ok', detail);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(id, { status: 'fail', message: msg, detail: msg, ms: Date.now() - t0 });
      logError('diag', 'Storage fail', msg);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - started;
  logInfo('diag', `Самопроверка завершена за ${report.elapsedMs}мс`, report.steps.map((s) => `${s.id}:${s.status}`).join(' '));
  onProgress?.(report);
  return report;
}

export function formatDiagReport(report: DiagReport): string {
  const lines: string[] = [];
  lines.push(`ПульсСети — самопроверка`);
  lines.push(`Начало: ${report.startedAt}`);
  lines.push(`Конец: ${report.finishedAt || '—'} (${report.elapsedMs ?? '—'} мс)`);
  lines.push(`Среда: ${report.native ? 'Android APK' : 'браузер'}`);
  lines.push(`---`);
  for (const s of report.steps) {
    const icon = s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : s.status === 'fail' ? '✗' : s.status === 'skip' ? '○' : '…';
    lines.push(`${icon} ${s.title} [${s.status}] — ${s.message} ${s.ms != null ? `(${s.ms}мс)` : ''}`);
    if (s.detail) lines.push(`  ↳ ${s.detail.replace(/\n/g, '\n  ↳ ')}`);
  }
  lines.push(`---`);
  lines.push(`Итог: ${report.steps.filter((s) => s.status === 'fail').length} ошибок, ${report.steps.filter((s) => s.status === 'warn').length} предупреждений`);
  return lines.join('\n');
}
