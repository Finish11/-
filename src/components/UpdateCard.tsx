import React, { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { ArrowDownToLine, CheckCircle2, Download, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react';
import { Button } from './ui/kit';
import {
  ApkUpdater,
  checkForUpdate,
  isUpdateSupported,
  RELEASE_PAGE,
  type UpdateInfo,
} from '../lib/appUpdate';

interface UpdateCardProps {
  /** Оставлен для совместимости вызовов: оформление теперь берётся из CSS-переменных. */
  darkMode?: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

type Phase = 'idle' | 'ready' | 'downloading' | 'downloaded' | 'installing' | 'permission' | 'error';

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
 * и открывает системный установщик. Работает только в нативной сборке.
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
  const downloadGeneration = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isUpdateSupported()) return;
    let alive = true;
    // Не мешаем старту приложения: проверяем через пару секунд после загрузки
    const timer = setTimeout(() => {
      checkForUpdate()
        .then((found) => {
          if (!alive || !found) return;
          setInfo(found);
          setPhase('ready');
          // APK не скачивается в фоне без ведома пользователя: на мобильной
          // сети это несколько мегабайт, а установщик не должен неожиданно
          // перекрывать первый экран разрешений.
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

  const startInstall = async () => {
    if (downloadId.current == null || !downloadReady.current || installLaunching.current) return;
    const generation = downloadGeneration.current;
    installLaunching.current = true;
    setPhase('installing');
    setError('');
    try {
      const res = await ApkUpdater.install({ downloadId: downloadId.current });
      if (generation !== downloadGeneration.current) return;
      if (res.needsPermission) {
        setPhase('permission');
        showToast('info', 'Разрешите установку из этого источника и вернитесь в ПульсСети');
      } else {
        showToast('success', 'Установщик открыт — подтвердите обновление в системном окне');
      }
    } catch (err) {
      if (generation === downloadGeneration.current) {
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Не удалось открыть установщик');
      }
    } finally {
      installLaunching.current = false;
    }
  };

  // Возврат из системного окна не должен создавать цикл настроек или тупик
  // после отмены установки. Разрешение сначала проверяем; если пользователь его
  // не выдал, остаёмся в приложении. После закрытия установщика даём кнопку повтора.
  useEffect(() => {
    if (phase !== 'permission' && phase !== 'installing') return;
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
        })
        .catch(() => {
          // Кнопка «Установить» остаётся доступна для следующей попытки.
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
      const { downloadId: id } = await ApkUpdater.download({
        url: target.downloadUrl,
        fileName: `pulsenet-${target.version}.apk`,
      });
      if (generation !== downloadGeneration.current) return;
      downloadId.current = id;
      let missingStatusCount = 0;

      // Последовательный polling: медленный ответ bridge не накапливает
      // параллельные запросы и не запускает установщик дважды.
      const poll = async () => {
        try {
          const status = await ApkUpdater.status({ downloadId: id });
          if (generation !== downloadGeneration.current) return;
          setProgress(status.progress || 0);
          if (status.state === 8) {
            stopPolling();
            downloadReady.current = true;
            setProgress(100);
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

  if (!info || dismissed) return null;

  const highlights = extractHighlights(info.notes);

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
          ) : (
            <Sparkles className="w-[18px] h-[18px]" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-extrabold">
              {phase === 'permission' ? 'Нужно разрешение' : `Доступно обновление ${info.version}`}
            </h3>
            <span className="text-[9.5px] font-mono px-1.5 py-0.5 rounded-md text-muted" style={{ background: 'var(--surface-2)' }}>
              сейчас {info.currentVersion} · {info.sizeMb} МБ
            </span>
          </div>

          <p className="text-[11px] text-dim mt-1 leading-snug">
            {phase === 'permission'
              ? 'Разрешите «Установка неизвестных приложений» для ПульсСети и вернитесь в приложение. Если передумали, просто вернитесь — настройки сами не откроются повторно.'
              : phase === 'installing'
              ? 'Установщик открыт. Подтвердите обновление в системном окне — приложение обновится поверх, данные сохранятся.'
              : phase === 'downloaded'
              ? 'APK скачан. Если вы закрыли системный установщик, откройте его ещё раз кнопкой ниже.'
              : phase === 'downloading'
              ? `Скачиваем APK: ${progress}%`
              : 'Новая версия уже собрана. Обновитесь, чтобы получить свежие проверки и исправления.'}
          </p>

          {highlights.length > 0 && phase !== 'downloading' && phase !== 'permission' && (
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
            {(phase === 'permission' || phase === 'downloaded' || (phase === 'error' && downloadReady.current)) && (
              <Button
                variant="soft"
                size="sm"
                icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
                onClick={startInstall}
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
