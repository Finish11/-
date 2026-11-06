import { App } from '@capacitor/app';
import { isNativeApp } from './nativeBridge';
import { ApkPlugin } from './apkPlugin';

/* ------------------------------------------------------------------ */
/*  Нативный плагин загрузки APK (android/.../ApkUpdaterPlugin.java)   */
/* ------------------------------------------------------------------ */

export interface ApkDownloadStart {
  downloadId: number;
}

export interface ApkDownloadStatus {
  /** 0 — неизвестно, 1 — в очереди, 2 — качается, 4 — пауза, 8 — готово, 16 — ошибка */
  state: number;
  progress: number;
  bytes?: number;
  total?: number;
}

export interface ApkInstallResult {
  /** true — нужно разрешить установку из этого источника (открылись настройки) */
  needsPermission: boolean;
}

interface ApkUpdaterPlugin {
  download(options: { url: string; fileName?: string }): Promise<ApkDownloadStart>;
  status(options: { downloadId: number }): Promise<ApkDownloadStatus>;
  install(options: { downloadId: number }): Promise<ApkInstallResult>;
  getPermissionState(): Promise<{ canInstall: boolean; androidSdk: number }>;
  openInstallSettings(): Promise<void>;
}

export const ApkUpdater = ApkPlugin as unknown as ApkUpdaterPlugin;

/* ------------------------------------------------------------------ */
/*  Проверка обновлений через GitHub Releases                          */
/* ------------------------------------------------------------------ */

const RELEASE_API = 'https://api.github.com/repos/Finish11/-/releases/tags/android-latest';
const RELEASE_PAGE = 'https://github.com/Finish11/-/releases/tag/android-latest';

export interface UpdateInfo {
  /** Версия из релиза, напр. 1.2.0 */
  version: string;
  currentVersion: string;
  /** Прямая ссылка на APK */
  downloadUrl: string;
  notes: string;
  sizeMb: number;
  pageUrl: string;
}

export const isUpdateSupported = (): boolean => isNativeApp();

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Текущая версия приложения — из Gradle (versionName), а не из бандла. */
export async function getCurrentVersion(): Promise<string> {
  if (!isNativeApp()) return '0.0.0';
  try {
    const info = await App.getInfo();
    return info.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Спрашивает последний релиз на GitHub. Возвращает null, если обновление не нужно
 * или сеть недоступна (обновление никогда не должно ломать запуск приложения).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isNativeApp()) return null;

  try {
    const currentVersion = await getCurrentVersion();
    const res = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;

    const release = (await res.json()) as {
      body?: string;
      html_url?: string;
      assets?: Array<{ name: string; browser_download_url: string; size: number }>;
    };

    const apk = (release.assets || []).find((a) => a.name.endsWith('.apk'));
    if (!apk) return null;

    const body = release.body || '';
    const versionMatch = body.match(/Верси[яи]:\s*([0-9]+(?:\.[0-9]+){1,3})/i);
    const version = versionMatch ? versionMatch[1] : '';
    if (!version || compareVersions(version, currentVersion) <= 0) return null;

    return {
      version,
      currentVersion,
      downloadUrl: apk.browser_download_url,
      notes: body,
      sizeMb: Math.round((apk.size / 1048576) * 10) / 10,
      pageUrl: release.html_url || RELEASE_PAGE,
    };
  } catch {
    return null;
  }
}

export { compareVersions, RELEASE_PAGE };
