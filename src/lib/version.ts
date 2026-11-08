/**
 * Версия интерфейса. Подставляется Vite из package.json — того же источника,
 * откуда берутся versionName в APK и номер в заметках релиза. Под tsx (тесты)
 * define не выполняется, поэтому нужен безопасный fallback.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Что показать в «О приложении»: установленная версия APK или версия сборки в вебе. */
export function versionLabel(installed: string | null | undefined, native: boolean): string {
  if (native && installed && installed !== '0.0.0') return installed;
  if (!native) return `${APP_VERSION} · веб`;
  return installed && installed !== '0.0.0' ? installed : APP_VERSION;
}
