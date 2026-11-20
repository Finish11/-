/**
 * Сквозной журнал приложения: копятся последние события, ошибки и результаты
 * самопроверок. Нужен, чтобы человек нажал «Копировать логи» и прислал
 * разработчику текст вместо скриншота — по скрину причину «YouTube не отдал
 * ни байта» не понять, а по логам видно таймаут, 403 и размер ответа.
 *
 * Журнал живёт в памяти (до 600 записей) и дублируется в localStorage для
 * автоматического сохранения ошибок между перезапусками. В проде console
 * дополнительно перехватывается, чтобы даже необработанный reject попал в лог.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogTag = 'app' | 'network' | 'site' | 'youtube' | 'speed' | 'vpn' | 'diag' | 'sync' | 'ui';

export interface LogEntry {
  ts: string;          // ISO
  ms: number;          // Date.now()
  level: LogLevel;
  tag: LogTag;
  message: string;
  detail?: string;     // стек / JSON
  count?: number;      // дедупликация повторов
}

const MAX_ENTRIES = 600;
const STORAGE_KEY = 'pulsenet.app_logs.v1';
const PERSIST_ERRORS_KEY = 'pulsenet.app_errors.v1';
const PERSIST_LIMIT = 80;

let buffer: LogEntry[] = [];
let listeners: Array<(entries: LogEntry[]) => void> = [];
let installed = false;
let originalConsoleError: typeof console.error | null = null;
let originalConsoleWarn: typeof console.warn | null = null;

function nowEntry(level: LogLevel, tag: LogTag, message: string, detail?: string): LogEntry {
  const ms = Date.now();
  return { ts: new Date(ms).toISOString(), ms, level, tag, message, detail: detail?.slice(0, 1200) };
}

function notify() {
  const snap = [...buffer];
  for (const fn of listeners) try { fn(snap); } catch { /* изолируем слушателей */ }
}

function push(entry: LogEntry) {
  // Склеиваем подряд идущие одинаковые сообщения (частые ретраи).
  const last = buffer[buffer.length - 1];
  if (last && last.level === entry.level && last.tag === entry.tag && last.message === entry.message && last.detail === entry.detail) {
    last.count = (last.count ?? 1) + 1;
    last.ms = entry.ms;
    last.ts = entry.ts;
    notify();
    // Ошибки всё равно сохраняем в persist, но без спама повторов.
    if (entry.level === 'error' && (last.count ?? 1) % 10 === 0) persistError(entry);
    return;
  }
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
  notify();
  if (entry.level === 'error' || entry.level === 'warn') persistError(entry);
}

function persistError(entry: LogEntry) {
  try {
    const raw = localStorage.getItem(PERSIST_ERRORS_KEY);
    const list: LogEntry[] = raw ? JSON.parse(raw) : [];
    list.push(entry);
    const trimmed = list.slice(-PERSIST_LIMIT);
    localStorage.setItem(PERSIST_ERRORS_KEY, JSON.stringify(trimmed));
  } catch { /* localStorage может быть недоступен */ }
}

export function logInfo(tag: LogTag, message: string, detail?: string) { push(nowEntry('info', tag, message, detail)); }
export function logDebug(tag: LogTag, message: string, detail?: string) { push(nowEntry('debug', tag, message, detail)); }
export function logWarn(tag: LogTag, message: string, detail?: string) { push(nowEntry('warn', tag, message, detail)); }
export function logError(tag: LogTag, message: string, detail?: string) { push(nowEntry('error', tag, message, detail)); }

// Совместимый алиас: короткий вызов для UI.
export const appLog = { info: logInfo, debug: logDebug, warn: logWarn, error: logError };

export function getLogs(): LogEntry[] { return [...buffer]; }

export function getPersistedErrors(): LogEntry[] {
  try {
    const raw = localStorage.getItem(PERSIST_ERRORS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as LogEntry[] : [];
  } catch { return []; }
}

export function clearLogs() {
  buffer = [];
  notify();
}
export function clearPersistedErrors() {
  try { localStorage.removeItem(PERSIST_ERRORS_KEY); } catch {}
}

export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.push(fn);
  // Сразу отдаём текущее состояние.
  try { fn([...buffer]); } catch {}
  return () => { listeners = listeners.filter((item) => item !== fn); };
}

export function formatLogs(entries: LogEntry[]): string {
  if (!entries.length) return 'Логов пока нет.';
  const header = `ПульсСети — логи приложения\nЭкспорт: ${new Date().toISOString()}\nЗаписей: ${entries.length}\n---\n`;
  const body = entries.map((e) => {
    const count = e.count && e.count > 1 ? ` ×${e.count}` : '';
    const lvl = e.level.toUpperCase().padEnd(5);
    const tag = e.tag.padEnd(7);
    const time = e.ts.slice(11, 19); // HH:MM:SS
    const base = `[${time}] ${lvl} ${tag} ${e.message}${count}`;
    return e.detail ? `${base}\n  ↳ ${e.detail.replace(/\n/g, '\n  ↳ ')}` : base;
  }).join('\n');
  return header + body;
}

export async function copyLogsToClipboard(entries?: LogEntry[]): Promise<boolean> {
  const text = formatLogs(entries ?? [...buffer, ...getPersistedErrors()].sort((a, b) => a.ms - b.ms));
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback для WebView без clipboard permission.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

export function installGlobalLogger() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Загружаем сохранённые ошибки сразу в буфер, чтобы они были видны после перезапуска.
  try {
    const persisted = getPersistedErrors();
    for (const e of persisted.slice(-20)) buffer.push(e);
  } catch {}

  // Перехватываем console.error/warn, чтобы сторонние ошибки тоже попали в лог.
  try {
    originalConsoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      try {
        const msg = args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
        push(nowEntry('error', 'app', msg.slice(0, 500)));
      } catch {}
      originalConsoleError?.(...args);
    };
    originalConsoleWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      try {
        const msg = args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(' ');
        push(nowEntry('warn', 'app', msg.slice(0, 500)));
      } catch {}
      originalConsoleWarn?.(...args);
    };
  } catch {}

  window.addEventListener('error', (event) => {
    const detail = event.error instanceof Error ? event.error.stack || event.error.message : `${event.filename}:${event.lineno}:${event.colno} ${event.message}`;
    logError('app', event.message || 'window.onerror', detail?.slice(0, 1000));
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logError('app', `unhandledrejection: ${String(message).slice(0, 400)}`, stack?.slice(0, 1000));
  });

  logInfo('app', 'Журнал приложения включён', `buffer ${MAX_ENTRIES}, persist ${PERSIST_LIMIT}`);
}

export function downloadLogs(entries?: LogEntry[]) {
  const text = formatLogs(entries ?? getLogs());
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pulsenet-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
