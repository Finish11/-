import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Bug, CheckCircle2, ClipboardCopy, Copy, Download, Play, RefreshCw, Square, Trash2, AlertTriangle, XCircle, Info } from 'lucide-react';
import { Button, Card, LoadingBar, Notice, SectionTitle } from './ui/kit';
import { getLogs, formatLogs, copyLogsToClipboard, downloadLogs, clearLogs, getPersistedErrors, clearPersistedErrors, subscribeLogs, type LogEntry, appLog } from '../lib/appLogger';
import { runDiagnostics, formatDiagReport, type DiagReport } from '../lib/diagnosticsRunner';

export const DiagnosticsView: React.FC<{ showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void }> = ({ showToast }) => {
  const [logs, setLogs] = useState<LogEntry[]>(() => getLogs());
  const [report, setReport] = useState<DiagReport | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all');
  const abortRef = React.useRef<AbortController | null>(null);

  useEffect(() => subscribeLogs(setLogs), []);

  const filteredLogs = React.useMemo(() => {
    if (filter === 'error') return logs.filter((l) => l.level === 'error');
    if (filter === 'warn') return logs.filter((l) => l.level === 'warn' || l.level === 'error');
    return logs;
  }, [logs, filter]);

  const start = useCallback(async () => {
    if (running) return;
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    appLog.info('diag', 'Запуск самопроверки пользователем');
    try {
      const rep = await runDiagnostics((r) => setReport({ ...r }), ctrl.signal);
      setReport(rep);
      const fails = rep.steps.filter((s) => s.status === 'fail').length;
      const warns = rep.steps.filter((s) => s.status === 'warn').length;
      if (fails) showToast('error', `Самопроверка: ${fails} ошибок, ${warns} предупреждений`);
      else if (warns) showToast('warning', `Самопроверка: ${warns} предупреждений`);
      else showToast('success', 'Самопроверка: все системы в норме');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as Error).name !== 'AbortError') {
        appLog.error('diag', 'Самопроверка прервана', msg);
        showToast('error', msg);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, showToast]);

  const stop = () => abortRef.current?.abort();

  // Сводка по шагу: сразу видно, прошёл ли он, и где сейчас самопроверка стоит.
  const countsOf = (steps: { status: string }[]) => ({
    ok: steps.filter((s) => s.status === 'ok').length,
    warn: steps.filter((s) => s.status === 'warn').length,
    fail: steps.filter((s) => s.status === 'fail').length,
    skip: steps.filter((s) => s.status === 'skip').length,
  });
  const summary = report ? countsOf(report.steps) : null;
  const doneCount = report ? report.steps.filter((s) => s.status !== 'running').length : 0;
  const currentStep = report?.steps.find((s) => s.status === 'running');
  const totalSteps = 11;
  const verdict = (() => {
    if (!summary) return null;
    if (summary.fail > 0) return { tone: 'bad' as const, text: `Нет нормы: ${summary.fail} ошибок, ${summary.warn} предупреждений` };
    if (summary.warn > 0) return { tone: 'warn' as const, text: `Почти всё в норме: ${summary.warn} предупреждение, ошибок нет` };
    return { tone: 'ok' as const, text: 'Все системы в норме: ошибок и предупреждений нет' };
  })();

  const copyReport = async () => {
    if (!report) return;
    const text = formatDiagReport(report) + '\n\n' + formatLogs(logs);
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', 'Отчёт скопирован');
      appLog.info('diag', 'Отчёт скопирован в буфер');
    } catch {
      showToast('warning', 'Не удалось скопировать — скачайте файл');
    }
  };

  const copyLogs = async () => {
    const ok = await copyLogsToClipboard(logs);
    showToast(ok ? 'success' : 'error', ok ? 'Логи скопированы' : 'Не удалось скопировать логи');
    if (ok) appLog.info('app', 'Логи скопированы пользователем');
  };

  const persisted = getPersistedErrors();

  return (
    <div className="space-y-4">
      <SectionTitle hint="Копируемые логи и проверка всех функций в один клик">Диагностика</SectionTitle>

      <Card accent>
        <div className="flex items-center gap-2 text-[12.5px] font-bold">
          <Activity className="w-4 h-4" /> Самопроверка
        </div>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Проверяет сеть, VPN-туннель, контрольные сайты, точки скорости, YouTube, обновление приложения и хранилище. Каждый шаг пишет в лог — даже зависший будет виден по таймауту. Запустите, скопируйте результат и отправьте разработчику вместе с описанием проблемы.
        </p>
        <div className="flex flex-wrap gap-2">
          {!running ? (
            <Button variant="primary" size="sm" icon={<Play className="w-4 h-4" />} onClick={() => void start()}>Запустить проверку</Button>
          ) : (
            <Button variant="outline" size="sm" icon={<Square className="w-4 h-4" />} onClick={stop}>Остановить</Button>
          )}
          {report && (
            <>
              <Button variant="soft" size="sm" icon={<ClipboardCopy className="w-4 h-4" />} onClick={() => void copyReport()}>Копировать отчёт</Button>
              <Button variant="outline" size="sm" icon={<Download className="w-4 h-4" />} onClick={() => downloadLogs(logs)}>Скачать логи</Button>
            </>
          )}
          <Button variant="ghost" size="sm" icon={<RefreshCw className="w-4 h-4" />} onClick={() => void start()} disabled={running}>Перезапустить</Button>
        </div>

        {running && (
          <div className="space-y-1.5 anim-fade-up">
            <LoadingBar
              label={currentStep
                ? `Шаг ${Math.min(doneCount + 1, totalSteps)} из ${totalSteps}: ${currentStep.title}`
                : `Самопроверка идёт — шаги появятся по мере прохождения`}
            />
            <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              Пройдено {doneCount} из {totalSteps} шагов · действий не нужно — она завершится сама.
            </div>
          </div>
        )}

        {report ? (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              {report.native ? 'Среда: приложение' : 'Среда: браузер'} · {report.elapsedMs != null ? `${(report.elapsedMs / 1000).toFixed(1)}с` : ''} · {report.steps.length} шагов
            </div>
            {verdict && (
              <Notice tone={verdict.tone}>
                <span className="font-bold">{verdict.text}</span>
              </Notice>
            )}
            <div className="divide-y rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--line)' }}>
              {report.steps.map((s) => {
                const color = s.status === 'ok' ? 'rgb(var(--success))' : s.status === 'warn' ? 'rgb(var(--warning))' : s.status === 'fail' ? 'rgb(var(--danger))' : 'var(--text-muted)';
                const Icon = s.status === 'ok' ? CheckCircle2 : s.status === 'warn' ? AlertTriangle : s.status === 'fail' ? XCircle : s.status === 'skip' ? Info : Activity;
                return (
                  <div key={s.id} className="px-3 py-2.5 flex gap-2.5" style={{ background: 'var(--surface-2)' }}>
                    <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-bold truncate">{s.title} <span className="font-normal text-[10px] ml-1" style={{ color }}>{s.status}</span> {s.ms != null && <span className="text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>{s.ms}мс</span>}</div>
                      <div className="text-[11px] leading-snug break-anywhere" style={{ color: 'var(--text-muted)' }}>{s.message}</div>
                      {s.detail && <div className="mt-1 text-[10px] font-mono break-anywhere whitespace-pre-wrap leading-snug" style={{ color: 'var(--text-muted)' }}>{s.detail}</div>}
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.hint}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <details className="text-[11px]">
              <summary className="cursor-pointer font-semibold" style={{ color: 'var(--text-muted)' }}>Копируемый отчёт</summary>
              <pre className="mt-2 p-3 rounded-xl border overflow-auto text-[10px] leading-relaxed whitespace-pre-wrap break-anywhere max-h-64" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--text)' }}>{formatDiagReport(report)}</pre>
              <Button variant="outline" size="sm" className="mt-2" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => void copyReport()}>Копировать отчёт + логи</Button>
            </details>
          </div>
        ) : (
          <Notice tone="info">Нажмите «Запустить проверку» — шаги появятся здесь с цветными статусами и временем каждого.</Notice>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[12.5px] font-bold"><Bug className="w-4 h-4" /> Журнал ошибок приложения</div>
          <span className="text-[10.5px] px-2 py-0.5 rounded-full border font-mono" style={{ borderColor: 'var(--line)', color: 'var(--text-muted)' }}>{logs.length} записей</span>
        </div>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Сюда попадают все ошибки сети, падений замеров и необработанные исключения. Журнал сохраняется между перезапусками (последние {persisted.length} ошибок), его можно скопировать одним нажатием.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button variant={filter === 'all' ? 'soft' : 'outline'} size="sm" onClick={() => setFilter('all')}>Все</Button>
          <Button variant={filter === 'warn' ? 'soft' : 'outline'} size="sm" onClick={() => setFilter('warn')}>Предупреждения</Button>
          <Button variant={filter === 'error' ? 'soft' : 'outline'} size="sm" onClick={() => setFilter('error')}>Только ошибки</Button>
          <Button variant="primary" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => void copyLogs()}>Копировать логи</Button>
          <Button variant="outline" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => { clearLogs(); clearPersistedErrors(); setLogs([]); showToast('info', 'Журнал очищен'); }}>Очистить</Button>
        </div>
        {filteredLogs.length === 0 ? (
          <div className="text-[11px] py-4 text-center rounded-xl border" style={{ color: 'var(--text-muted)', borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
            Записей по фильтру нет. Попробуйте «Все».
          </div>
        ) : (
          <div className="space-y-1 max-h-[360px] overflow-auto pr-1 stagger">
            {filteredLogs.slice(-120).reverse().map((entry, idx) => {
              const bg = entry.level === 'error' ? 'rgb(var(--danger) / 0.08)' : entry.level === 'warn' ? 'rgb(var(--warning) / 0.08)' : 'var(--surface-2)';
              const border = entry.level === 'error' ? 'rgb(var(--danger) / 0.35)' : entry.level === 'warn' ? 'rgb(var(--warning) / 0.35)' : 'var(--line)';
              return (
                <div key={`${entry.ms}-${idx}`} className="rounded-xl border px-3 py-2 break-anywhere" style={{ background: bg, borderColor: border }}>
                  <div className="flex items-center gap-1.5 text-[10.5px] font-semibold flex-wrap">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border" style={{ borderColor: border, color: entry.level === 'error' ? 'rgb(var(--danger))' : entry.level === 'warn' ? 'rgb(var(--warning))' : 'var(--text-muted)' }}>{entry.level}</span>
                    <span className="px-1.5 py-0.5 rounded bg-[var(--surface)] border text-[9px] font-mono" style={{ borderColor: 'var(--line)', color: 'var(--text-muted)' }}>{entry.tag}</span>
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{entry.ts.slice(11, 19)}</span>
                    {entry.count && entry.count > 1 && <span className="text-[10px]" style={{ color: 'rgb(var(--danger))' }}>×{entry.count}</span>}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug font-medium break-anywhere whitespace-pre-wrap" style={{ color: 'var(--text)' }}>{entry.message}</div>
                  {entry.detail && <div className="mt-1 text-[10px] font-mono whitespace-pre-wrap break-anywhere leading-snug" style={{ color: 'var(--text-muted)' }}>{entry.detail}</div>}
                </div>
              );
            })}
          </div>
        )}
        <details className="text-[11px]">
          <summary className="cursor-pointer font-semibold" style={{ color: 'var(--text-muted)' }}>Показать как текст (копируемый)</summary>
          <textarea readOnly value={formatLogs(filteredLogs)} rows={8} className="mt-2 w-full p-2.5 rounded-xl border font-mono text-[10px] leading-relaxed" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--text)' }} />
        </details>
      </Card>

      <Notice tone="info">
        Совет: когда YouTube пишет «не отдал ни байта» или сайт даёт 403 — запустите проверку, скопируйте логи и приложите к сообщению. В логах видны коды ответов, время и маршрут (VPN/прямо).
      </Notice>
    </div>
  );
};
