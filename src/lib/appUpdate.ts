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
  /** Номер сборки Android из релиза (versionCode), 0 если не указан. */
  buildNumber: number;
  /** Номер сборки установленного приложения. */
  currentBuildNumber: number;
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

/** Установленный versionCode: на Android Capacitor отдаёт его в поле build. */
export async function getCurrentBuildNumber(): Promise<number> {
  if (!isNativeApp()) return 0;
  try {
    const info = await App.getInfo();
    const code = Number.parseInt(info.build, 10);
    return Number.isFinite(code) ? code : 0;
  } catch {
    return 0;
  }
}

/** «Версия: 1.8.0 (versionCode 108000012)» → 108000012. */
export function parseBuildNumber(notes: string): number {
  const match = notes.match(/versionCode\s+(\d+)/i);
  const code = match ? Number.parseInt(match[1], 10) : 0;
  return Number.isFinite(code) ? code : 0;
}

/**
 * Есть ли обновление.
 *
 * Сравниваем не только X.Y.Z, но и номер сборки: каждая пересборка получает
 * новый versionCode, поэтому даже маленькая правка приходит в приложение.
 * Раньше сравнивалась только версия — и новые APK под тем же номером
 * молча не предлагались.
 */
export function hasUpdate(
  releaseVersion: string,
  releaseBuild: number,
  installedVersion: string,
  installedBuild: number
): boolean {
  if (!releaseVersion) return false;
  const byVersion = compareVersions(releaseVersion, installedVersion);
  if (byVersion > 0) return true;
  if (byVersion < 0) return false;
  // Версия та же — решает номер сборки, но только если он известен с обеих сторон.
  return releaseBuild > 0 && installedBuild > 0 && releaseBuild > installedBuild;
}

/** Почему проверка не дала обновление — чтобы UI не врал «последняя версия». */
export type UpdateCheckFailure =
  | 'not-native'
  | 'network'
  | 'rate-limit'
  | 'no-apk'
  | 'no-version'
  | 'up-to-date';

export interface UpdateCheckResult {
  update: UpdateInfo | null;
  /** Заполняется, только когда обновления нет. */
  reason?: UpdateCheckFailure;
  /** Понятное человеку объяснение причины. */
  message?: string;
}

/**
 * Спрашивает последний релиз на GitHub.
 *
 * Раньше функция возвращала `null` и на «обновлений нет», и на любую сетевую
 * ошибку: интерфейс не мог отличить одно от другого и писал «Установлена
 * последняя версия», даже когда GitHub был недоступен (в РФ api.github.com
 * регулярно не отвечает). Из-за этого же не показывалось «Не удалось проверить
 * обновления» — сообщение было недостижимым. Теперь причина возвращается явно.
 */
export async function checkForUpdateResult(): Promise<UpdateCheckResult> {
  if (!isNativeApp()) {
    return { update: null, reason: 'not-native', message: 'Проверка обновлений работает в приложении для Android' };
  }

  let release: {
    body?: string;
    html_url?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      // Без таймаута запрос мог висеть десятки секунд, и кнопка «Проверить»
      // выглядела зависшей.
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(12000)
        : undefined,
    });
    if (res.status === 403 || res.status === 429) {
      return {
        update: null,
        reason: 'rate-limit',
        message: 'GitHub временно ограничил проверку обновлений. Попробуйте через несколько минут — скачать APK можно со страницы релиза.',
      };
    }
    if (!res.ok) {
      return { update: null, reason: 'network', message: `GitHub ответил ${res.status}. Проверьте соединение или скачайте APK со страницы релиза.` };
    }
    release = (await res.json()) as typeof release;
  } catch (error) {
    return {
      update: null,
      reason: 'network',
      message: `Не удалось связаться с GitHub: ${error instanceof Error ? error.message : String(error)}. Это сеть, а не установленная версия.`,
    };
  }

  const [currentVersion, currentBuildNumber] = await Promise.all([getCurrentVersion(), getCurrentBuildNumber()]);
  const apk = (release.assets || []).find((a) => a.name.endsWith('.apk'));
  if (!apk) {
    return { update: null, reason: 'no-apk', message: 'В релизе нет APK-файла — обновляться нечем. Откройте страницу релиза.' };
  }

  const body = release.body || '';
  const versionMatch = body.match(/Верси[яи]:\s*([0-9]+(?:\.[0-9]+){1,3})/i);
  const version = versionMatch ? versionMatch[1] : '';
  const buildNumber = parseBuildNumber(body);
  if (!version) {
    return { update: null, reason: 'no-version', message: 'В описании релиза нет номера версии — сравнить не с чем.' };
  }
  if (!hasUpdate(version, buildNumber, currentVersion, currentBuildNumber)) {
    return { update: null, reason: 'up-to-date' };
  }

  return {
    update: {
      version,
      currentVersion,
      buildNumber,
      currentBuildNumber,
      downloadUrl: apk.browser_download_url,
      notes: body,
      sizeMb: Math.round((apk.size / 1048576) * 10) / 10,
      pageUrl: release.html_url || RELEASE_PAGE,
    },
  };
}

/**
 * Совместимая обёртка: обновление или null. Для фоновой автопроверки, где
 * причина не нужна и ошибка не должна ничего показывать.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    return (await checkForUpdateResult()).update;
  } catch {
    return null;
  }
}

export { compareVersions, RELEASE_PAGE };
