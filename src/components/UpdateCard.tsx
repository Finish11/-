import React, { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { ArrowDownToLine, CheckCircle2, Download, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react';
import {
  ApkUpdater,
  checkForUpdate,
  isUpdateSupported,
  RELEASE_PAGE,
  type UpdateInfo,
} from '../lib/appUpdate';

interface UpdateCardProps {
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

type Phase = 'idle' | 'ready' | 'downloading' | 'installing' | 'permission' | 'error';

/** Короткий список изменений из описания релиза (без служебных строк). */
function extractHighlights(notes: string): string[] {
  return notes
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(
      (l) =>
        l.length > 8 &&
        !/^(версия|коммит|собрано|прямая ссылка|установка|подпись)/i.test(l) &&
        !l.startsWith('http')
    )
    .slice(0, 3);
}

/**
 * Карточка обновления: показывает новую версию APK, скачивает её внутри приложения
 * и открывает системный установщик. Работает только в нативной сборке.
 */
export const UpdateCard: React.FC<UpdateCardProps> = ({ darkMode, showToast }) => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  const downloadId = useRef<number | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const startInstall = async () => {
    if (downloadId.current == null) return;
    setPhase('installing');
    try {
      const res = await ApkUpdater.install({ downloadId: downloadId.current });
      if (res.needsPermission) {
        setPhase('permission');
        showToast('info', 'Разрешите установку из этого источника и нажмите «Установить» ещё раз');
      } else {
        showToast('success', 'Установщик открыт — подтвердите обновление в системном окне');
      }
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Не удалось открыть установщик');
    }
  };

  // Вернулись из системных настроек «Установка неизвестных приложений» —
  // сразу пробуем открыть установщик снова, без лишних нажатий.
  useEffect(() => {
    if (phase !== 'permission') return;
    let remove: (() => void) | undefined;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void startInstall();
    })
      .then((h) => {
        remove = () => void h.remove();
      })
      .catch(() => undefined);
    return () => remove?.();
  }, [phase]);

  const handleUpdate = async () => {
    if (!info) return;
    setPhase('downloading');
    setProgress(0);
    setError('');

    try {
      const { downloadId: id } = await ApkUpdater.download({
        url: info.downloadUrl,
        fileName: `pulsenet-${info.version}.apk`,
      });
      downloadId.current = id;

      stopPolling();
      pollTimer.current = setInterval(async () => {
        try {
          const status = await ApkUpdater.status({ downloadId: id });
          setProgress(status.progress || 0);
          if (status.state === 8) {
            stopPolling();
            setProgress(100);
            await startInstall();
          } else if (status.state === 16) {
            stopPolling();
            setPhase('error');
            setError('Загрузка прервалась. Проверьте интернет и попробуйте снова.');
          }
        } catch {
          stopPolling();
          // DownloadManager на части прошивок не отдаёт статус — не оставляем
          // пользователя в тупике, а открываем прямую ссылку на APK.
          // Загрузка обычно идёт нормально, просто система не делится статусом.
          // Поэтому сразу пробуем открыть установщик, а если файл ещё не готов —
          // подсказываем про уведомление и даём ссылку на APK.
          setPhase('installing');
          try {
            await startInstall();
          } catch {
            setPhase('error');
            setError(
              'Загрузка идёт в фоне. Когда закончится, придёт уведомление — нажмите на него, либо скачайте APK по ссылке ниже.'
            );
          }
        }
      }, 800);
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Не удалось начать загрузку');
    }
  };

  if (!info || dismissed) return null;

  const card = darkMode
    ? 'bg-gradient-to-br from-sky-500/15 via-slate-900/70 to-slate-900/70 border-sky-500/30'
    : 'bg-gradient-to-br from-sky-50 via-white to-white border-sky-200';
  const chip = darkMode ? 'bg-slate-950/60 border-slate-700/70' : 'bg-white border-slate-200';
  const highlights = extractHighlights(info.notes);

  return (
    <div className={`mb-4 rounded-3xl border p-4 sm:p-5 relative overflow-hidden ${card}`}>
      <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-sky-500/10 blur-2xl pointer-events-none" />

      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-2xl bg-sky-500/20 border border-sky-400/40 flex items-center justify-center shrink-0">
          {phase === 'installing' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          ) : phase === 'downloading' ? (
            <Loader2 className="w-5 h-5 text-sky-400 animate-spin" />
          ) : (
            <Sparkles className="w-5 h-5 text-sky-400" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-extrabold">
              {phase === 'permission' ? 'Нужно разрешение' : `Доступно обновление ${info.version}`}
            </h3>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md border ${chip} text-slate-400`}>
              сейчас {info.currentVersion} · {info.sizeMb} МБ
            </span>
          </div>

          <p className="text-[11px] text-slate-400 mt-1 leading-snug">
            {phase === 'permission'
              ? 'Разрешите «Установка неизвестных приложений» для ПульсСети и вернитесь в приложение — установка начнётся сразу.'
              : phase === 'installing'
              ? 'Установщик открыт. Подтвердите обновление в системном окне — приложение обновится поверх, данные сохранятся.'
              : phase === 'downloading'
              ? `Скачиваем APK: ${progress}%`
              : 'Новая версия уже собрана. Обновитесь, чтобы получить свежие проверки и исправления.'}
          </p>

          {highlights.length > 0 && phase !== 'downloading' && phase !== 'permission' && (
            <ul className="mt-2 space-y-0.5">
              {highlights.map((line, i) => (
                <li key={i} className="text-[11px] text-slate-400 flex gap-1.5">
                  <span className="text-sky-400 shrink-0">•</span>
                  <span className="line-clamp-2">{line}</span>
                </li>
              ))}
            </ul>
          )}

          {(phase === 'downloading' || phase === 'installing') && (
            <div className="mt-2.5 h-2 rounded-full bg-slate-800/80 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-all duration-500"
                style={{ width: `${phase === 'installing' ? 100 : progress}%` }}
              />
            </div>
          )}

          {phase === 'error' && (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-400">
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
            {(phase === 'ready' || phase === 'error') && (
              <button
                type="button"
                onClick={handleUpdate}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-500 text-slate-950 text-xs font-bold active:scale-95 transition-transform"
              >
                <Download className="w-3.5 h-3.5" />
                {phase === 'error' ? 'Попробовать снова' : 'Обновить приложение'}
              </button>
            )}
            {phase === 'permission' && (
              <button
                type="button"
                onClick={startInstall}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500 text-slate-950 text-xs font-bold active:scale-95 transition-transform"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                Установить
              </button>
            )}
            {phase === 'downloading' && (
              <span className="text-[11px] text-slate-400 font-mono">
                {progress}% · не закрывайте приложение
              </span>
            )}
            <a
              href={RELEASE_PAGE}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-slate-400 hover:text-sky-400 underline decoration-dotted"
            >
              что нового
            </a>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            stopPolling();
            setDismissed(true);
          }}
          className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-500/10 shrink-0"
          aria-label="Скрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
