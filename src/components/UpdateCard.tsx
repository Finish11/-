import React, { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { CheckCircle2, Download, Loader2, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { Button } from './ui/kit';
import {
  ApkUpdater,
  checkForUpdateResult,
  isUpdateSupported,
  RELEASE_PAGE,
  type UpdateInfo,
} from '../lib/appUpdate';

interface UpdateCardProps {
  /** Оставлен для совместимости вызовов: оформление теперь берётся из CSS-переменных. */
  darkMode?: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

type Phase = 'idle' | 'ready' | 'downloading' | 'downloaded' | 'granting' | 'permission' | 'installing' | 'error';

/** Короткий список изменений из описания релиза (без служебных строк). */
function extractHighlights(notes: string): string[] {
  return notes
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(
      (l) =>
        l.length > 8 &&
        !/^(версия|коммит|собрано|прямая ссылка|установка|подпись|что нового|изменения|основные изменения)/i.test(l) &&
        !l.startsWith('http')
    )
    .slice(0, 3);
}

/**
 * Карточка обновления: показывает новую версию APK, скачивает её внутри приложения
 * и запускает системный установщик **сам собой**.
 *
 * Почему так, а не «скачал и жди ручного запуска»: ранее после скачивания
 * приложение просто ставило кнопку «Установить» и молчало, и пользователю
 * приходилось самому открывать установщик. Теперь после готовности APK
 * запускается цепочка: запрос всех нужных разрешений (уведомления + установка)
 * → системный установщик → после возврата в приложение, если разрешение
 * выдано, установка запускается автоматически.
 */
export const UpdateCard: React.FC<UpdateCardProps> = ({ showToast }) => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  const downloadId = useRef<number | null>(null);
  const downloadReady = useRef(false);
  const downloadStarting = useRef(false);
  const installLaunching = useRef(false);
  const installGeneration = useRef(0);
  const downloadGeneration = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isUpdateSupported()) return;
    let alive = true;
    // Не мешаем старту приложения: проверяем через пару секунд после загрузки
    const timer = setTimeout(() => {
      checkForUpdateResult()
        .then((result) => {
          if (!alive || !result.update) return;
          setInfo(result.update);
          setPhase('ready');
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      alive = false;
      downloadGeneration.current += 1;
      clearTimeout(timer);
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  /**
   * Запуск установки с automatikой по разрешающей системе.
   * 1) Если разрешения на установку ещё нет — запрашиваем их (разрешающая
   *    система ACTION_REQUEST_INSTALL_PACKAGES), ставим phase 'granting'.
   *    После возврата из системного окна listener сам вызовет этот метод
   *    снова — и установка пойдёт без дополнительного тапа.
   * 2) Если разрешение есть — открываем установщик. Если система все равно
   *    говорит, что разрешения нет — снова запрашиваем, ставим 'permission'.
   */
  const startInstall = async () => {
    if (downloadId.current == null || !downloadReady.current || installLaunching.current) return;
    const generation = installGeneration.current;
    installLaunching.current = true;
    setError('');
    try {
      const perm = await ApkUpdater.getPermissionState();
      if (generation !== installGeneration.current) return;
      if (!perm.canInstall) {
        // Запрашиваем все нужные разрешения и ждем возврата.
        setPhase('granting');
        showToast(
          'info',
          'Нужно разрешение на установку: подтвердите его в системе и вернитесь в ПульсСети — обновление установится само'
        );
        try {
          await ApkUpdater.requestInstallPermission();
        } catch (e) {
          // Переход в 'permission' ниже всё равно оставляет кнопку повтора.
          if (generation !== installGeneration.current) return;
          setPhase('permission');
          setError(e instanceof Error ? e.message : 'Не удалось запросить разрешение');
        }
        return;
      }

      setPhase('installing');
      const res = await ApkUpdater.install({ downloadId: String(downloadId.current) });
      if (generation !== installGeneration.current) return;
      if (res.needsPermission) {
        // Система не пустила установщик: запрашиваем разрешение повторно.
        setPhase('permission');
        try {
          const again = await ApkUpdater.requestInstallPermission();
          if (generation !== installGeneration.current) return;
          if (again.canInstall) {
            showToast('info', 'Разрешение получено — вернитесь, обновление установится само');
          } else {
            showToast('warning', 'Разрешение ещё не выдано: разрешите установку в системе');
          }
        } catch {
          // Кнопка «Разрешить/Установить» остаётся доступна для следующей попытки.
        }
      } else {
        showToast('success', 'Установщик открыт — подтвердите обновление в системном окне');
      }
    } catch (err) {
      if (generation === installGeneration.current) {
        setPhase('permission');
        setError(err instanceof Error ? err.message : 'Не удалось открыть установщик');
      }
    } finally {
      if (generation === installGeneration.current) installLaunching.current = false;
    }
  };

  // Возврат из системного окна (разрешение или установщик) должен продолжить
  // цепочку, а не создавать тупик. Если разрешение выдано — автоматически
  // запускаем установку; если нет — остаёмся на кнопке.
  useEffect(() => {
    if (phase !== 'granting' && phase !== 'permission' && phase !== 'installing') return;
    let disposed = false;
    let remove: (() => void) | undefined;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive || disposed) return;
      if (phase === 'installing') {
        setPhase('downloaded');
        return;
      }
      void ApkUpdater.getPermissionState()
        .then(async (permission) => {
          if (disposed) return;
          if (permission.canInstall) await startInstall();
          else {
            setPhase('permission');
            showToast('warning', 'Разрешение ещё не выдано: разрешите установку и вернитесь в ПульсСети');
          }
        })
        .catch(() => {
          // Кнопка остаётся доступна для следующей попытки.
        });
    })
      .then((h) => {
        if (disposed) void h.remove();
        else remove = () => void h.remove();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      remove?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const beginDownload = async (target: UpdateInfo) => {
    if (downloadStarting.current) return;
    downloadStarting.current = true;
    const generation = ++downloadGeneration.current;
    stopPolling();
    downloadReady.current = false;
    downloadId.current = null;
    setPhase('downloading');
    setProgress(0);
    setError('');

    try {
      const started = await ApkUpdater.download({
        url: target.downloadUrl,
        fileName: `pulsenet-${target.version}.apk`,
      });
      if (generation !== downloadGeneration.current) return;
      // Без downloadId опрашивать нечего: раньше undefined превращался в
      // state 0 и приложение пять раз сообщало «Android не нашёл системную
      // загрузку». Проверяем сразу и говорим прямо.
      const id = Number(started && started.downloadId);
      if (!Number.isFinite(id) || id <= 0) {
        setPhase('error');
        setError('Android не начал загрузку APK. Проверьте, что в системе включён «Загрузчик» (Download Manager), и попробуйте снова.');
        return;
      }
      downloadId.current = id;
      let missingStatusCount = 0;

      // Последовательный polling: медленный ответ bridge не накапливает
      // параллельные запросы и не запускает установщик дважды.
      const poll = async () => {
        try {
          const status = await ApkUpdater.status({ downloadId: String(id) });
          if (generation !== downloadGeneration.current) return;
          setProgress(status.progress || 0);
          if (status.state === 8) {
            stopPolling();
            downloadReady.current = true;
            setProgress(100);
            // Готово — запускаем установку САМОЙ: сначала разрешения, затем
            // системный установщик. Без этого пользователь видел бы только
            // «скачал, нажми Установить».
            await startInstall();
            return;
          }
          if (status.state === 16) {
            stopPolling();
            setPhase('error');
            setError('Загрузка прервалась. Проверьте интернет и попробуйте снова.');
            return;
          }
          if (status.state === 0) {
            missingStatusCount += 1;
            if (missingStatusCount >= 5) {
              stopPolling();
              setPhase('error');
              setError('Android не нашёл системную загрузку. Попробуйте начать её заново.');
              return;
            }
          } else {
            missingStatusCount = 0;
          }
          pollTimer.current = setTimeout(() => void poll(), 800);
        } catch {
          if (generation !== downloadGeneration.current) return;
          stopPolling();
          setPhase('error');
          setError(
            'Не удалось получить статус загрузки. Она может продолжаться в фоне: проверьте уведомление Android или начните заново.'
          );
        }
      };
      pollTimer.current = setTimeout(() => void poll(), 800);
    } catch (err) {
      if (generation === downloadGeneration.current) {
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Не удалось начать загрузку');
      }
    } finally {
      downloadStarting.current = false;
    }
  };

  /** Повторный запрос разрешений — кнопка «Разрешить/Установить». */
  const requestAndInstall = async () => {
    // Сбрасываем генерацию, чтобы прежний pending install не завершался.
    installGeneration.current += 1;
    setError('');
    await startInstall();
  };

  if (!info || dismissed) return null;

  const highlights = extractHighlights(info.notes);
  const needsPermission = phase === 'granting' || phase === 'permission';

  return (
    <div
      className="mb-3 rounded-2xl border p-3.5 relative overflow-hidden"
      style={{ borderColor: 'rgb(var(--accent) / 0.35)', background: 'var(--surface)' }}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="w-9 h-9 rounded-xl grid place-items-center shrink-0"
          style={{ background: 'var(--accent-soft)', color: 'rgb(var(--accent))' }}
        >
          {phase === 'installing' || phase === 'downloaded' ? (
            <CheckCircle2 className="w-[18px] h-[18px]" style={{ color: 'rgb(var(--success))' }} />
          ) : phase === 'downloading' ? (
            <Loader2 className="w-[18px] h-[18px] animate-spin" />
          ) : needsPermission ? (
            <ShieldCheck className="w-[18px] h-[18px]" />
          ) : (
            <Sparkles className="w-[18px] h-[18px]" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-extrabold">
              {phase === 'granting' ? 'Разрешение на установку'
                : phase === 'permission' ? 'Нужно разрешение'
                : info.version === info.currentVersion
                ? `Доступна новая сборка ${info.version}`
                : `Доступно обновление ${info.version}`}
            </h3>
            <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded-md text-muted" style={{ background: 'var(--surface-2)' }}>
              сейчас {info.currentVersion}
              {info.version === info.currentVersion && info.currentBuildNumber > 0
                ? ` (сборка ${info.currentBuildNumber} → ${info.buildNumber})`
                : ''} · {info.sizeMb} МБ
            </span>
          </div>

          <p className="text-[11px] text-dim mt-1 leading-snug">
            {phase === 'granting'
              ? 'Откроется система: разрешите установку из этого источника и уведомления. Вернитесь в ПульсСети — обновление установится само, без ручного запуска.'
              : phase === 'permission'
              ? 'Разрешите «Установка неизвестных приложений» для ПульсСети и вернитесь. После этого обновление запустится автоматически.'
              : phase === 'installing'
              ? 'Установщик открыт. Подтвердите обновление в системном окне — приложение обновится поверх, данные сохранятся.'
              : phase === 'downloaded'
              ? 'APK скачан. Установщик открывается автоматически; если вы закрыли его, откройте ещё раз кнопкой ниже.'
              : phase === 'downloading'
              ? `Скачиваем APK: ${progress}%`
              : 'Новая версия уже собрана. Обновитесь, чтобы получить свежие проверки и исправления — приложение само скачает и установит её.'}
          </p>

          {highlights.length > 0 && !needsPermission && phase !== 'downloading' && (
            <ul className="mt-2 space-y-0.5">
              {highlights.map((line, i) => (
                <li key={i} className="text-[11px] text-dim flex gap-1.5">
                  <span className="shrink-0" style={{ color: 'rgb(var(--accent))' }}>•</span>
                  <span className="line-clamp-2">{line}</span>
                </li>
              ))}
            </ul>
          )}

          {(phase === 'downloading' || phase === 'installing' || phase === 'downloaded') && (
            <div className="mt-2.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${phase === 'installing' ? 100 : progress}%`,
                  background: 'linear-gradient(90deg, rgb(var(--accent)), rgb(var(--success)))',
                }}
              />
            </div>
          )}

          {phase === 'error' && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px]" style={{ color: 'rgb(var(--danger))' }}>
              <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {error}. Можно{' '}
                <a href={RELEASE_PAGE} target="_blank" rel="noreferrer" className="underline">
                  скачать вручную со страницы релиза
                </a>
                .
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 mt-3">
            {(phase === 'ready' || (phase === 'error' && !downloadReady.current)) && (
              <Button
                variant="primary"
                size="sm"
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={() => info && void beginDownload(info)}
              >
                {phase === 'error' ? 'Попробовать снова' : 'Скачать и установить'}
              </Button>
            )}
            {needsPermission && (
              <Button
                variant="primary"
                size="sm"
                icon={<ShieldCheck className="w-3.5 h-3.5" />}
                onClick={() => void requestAndInstall()}
              >
                {phase === 'granting' ? 'Разрешить установку' : 'Разрешить и установить'}
              </Button>
            )}
            {(phase === 'downloaded' || (phase === 'error' && downloadReady.current)) && (
              <Button
                variant="soft"
                size="sm"
                icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                onClick={() => void requestAndInstall()}
              >
                Установить
              </Button>
            )}
            {phase === 'downloading' && (
              <span className="text-[11px] text-muted font-mono">
                {progress}% · не закрывайте приложение
              </span>
            )}
            <a
              href={RELEASE_PAGE}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted hover:text-[color:var(--text)] underline decoration-dotted"
            >
              что нового
            </a>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            downloadGeneration.current += 1;
            installGeneration.current += 1;
            stopPolling();
            setPhase('idle');
            setDismissed(true);
          }}
          className="tap-icon tap text-muted hover:text-[color:var(--text)] shrink-0"
          aria-label="Скрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
