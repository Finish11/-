import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Activity, Gauge, Info, Play, SlidersHorizontal, Square, Trash2, Waves } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { communityEndpoint } from '../lib/community';
import { isNativeApp } from '../lib/nativeBridge';
import { suggestActiveNode } from '../lib/appConfirmations';
import { runSpeedTest, SPEED_TRAFFIC, type SpeedProgress, type SpeedTestResult } from '../lib/speedRunner';
import { normalizeSpeedRunPayload } from '../lib/speedPayload';
import { useSettings } from '../lib/appSettings';
import { queuePendingSpeedRun, readPendingSpeedRuns, SPEED_PENDING_KEY } from '../lib/speedPending';
import { availableSpeedServers, type SpeedServer } from '../lib/speedEndpoints';
import {
  bufferbloatVerdict, compareConfigs, formatBytes, guessSpeedCap, networkKindLabel, speedGaugeFraction,
  recordedSpeedRoute, speedTraceGeometry, speedUsageVerdict, subscriptionSpeedRows, systemSpeedRoute,
  gaugeTicks, speedUnitLabel, formatSpeedIn, type GaugeCeiling, type SpeedDisplayUnit, type SpeedRun, type SpeedTracePoint,
} from '../lib/speedTest';
import type { ClientConnectionInfo, VpnProfile, VpnSubscription } from '../types';
import { Button, Chip, EmptyState, Notice, SectionTitle } from './ui/kit';

interface SpeedTestViewProps {
  connection: ClientConnectionInfo | null;
  profiles: VpnProfile[];
  subscriptions?: VpnSubscription[];
  confirmationProfileId: number | null;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const PHASE_LABEL: Record<SpeedProgress['phase'], string> = {
  select: 'Выбор сервера', ping: 'Задержка', warmup: 'Разогрев',
  download: 'Загрузка', upload: 'Отдача', done: 'Готово', error: 'Ошибка',
};

/**
 * Спидометр как в Speedtest: дуга, стрелка, шкала с выбранным потолком и
 * единицы (Мбит/с или МБ/с). В центре до запуска — кнопка «Замерить», чтобы
 * не приходилось прокручивать экран вниз ради старта.
 */
const SpeedGauge: React.FC<{
  mbps: number; running: boolean; phase: string; progress: number; direction?: string;
  unit: SpeedDisplayUnit; ceiling: GaugeCeiling; idle: boolean; onStart: () => void;
}> = ({ mbps, running, phase, progress, direction, unit, ceiling, idle, onStart }) => {
  const fraction = speedGaugeFraction(mbps, ceiling);
  const startAngle = -210;
  const sweep = 240;
  const angle = startAngle + sweep * fraction;
  const radius = 108;
  const center = 130;
  const polar = (deg: number, r: number) => {
    const rad = (deg * Math.PI) / 180;
    return { x: center + r * Math.cos(rad), y: center + r * Math.sin(rad) };
  };
  const arc = (from: number, to: number, r: number) => {
    const a = polar(from, r);
    const b = polar(to, r);
    return `M ${a.x} ${a.y} A ${r} ${r} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
  };
  const needleFrom = polar(angle, radius - 34);
  const needleTo = polar(angle, radius - 18);
  const ticks = gaugeTicks(ceiling);
  return (
    <div className="relative mx-auto w-full" style={{ maxWidth: 260 }}>
      <svg viewBox="0 0 260 226" className="w-full block" role="img" aria-label={`Скорость ${formatSpeedIn(mbps, unit)} ${speedUnitLabel(unit)}`}>
        <path d={arc(startAngle, startAngle + sweep, radius)} fill="none" stroke="var(--surface-2)" strokeWidth="12" strokeLinecap="round" />
        {!idle && (
          <path
            d={arc(startAngle, startAngle + Math.max(0.6, sweep * fraction), radius)}
            fill="none" stroke="rgb(var(--accent))" strokeWidth="12" strokeLinecap="round"
          />
        )}
        {/* Стрелка — короткий указатель в кольце шкалы: через цифры в центре
            она больше не проходит и ничего не перекрывает. */}
        {!idle && (
          <line
            x1={needleFrom.x} y1={needleFrom.y} x2={needleTo.x} y2={needleTo.y}
            stroke={running ? 'rgb(var(--accent))' : 'var(--text-muted)'} strokeWidth="4" strokeLinecap="round"
            className="gauge-needle"
          />
        )}
        {ticks.map((tick) => {
          const tickAngle = startAngle + sweep * speedGaugeFraction(tick, ceiling);
          const outer = polar(tickAngle, radius - 11);
          const inner = polar(tickAngle, radius - 19);
          const label = polar(tickAngle, radius - 45);
          return (
            <g key={tick}>
              <line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke="var(--line)" strokeWidth="2" />
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="var(--text-muted)">
                {unit === 'MBps' ? Math.round((tick / 8) * 10) / 10 : tick}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Центр шкалы: кнопка старта или текущее значение — никогда одновременно. */}
      <div className="absolute inset-x-0 mx-auto flex flex-col items-center justify-center" style={{ top: '34%', bottom: '20%', maxWidth: 128 }}>
        {idle ? (
          <button
            type="button"
            onClick={onStart}
            className="grid place-items-center rounded-full text-[12.5px] font-extrabold uppercase tap"
            style={{ width: 100, height: 100, letterSpacing: '0.02em', border: '2px solid rgb(var(--accent))', color: 'rgb(var(--accent))', background: 'var(--surface)' }}
          >
            Замерить
          </button>
        ) : (
          <>
            <div className="text-[32px] font-black leading-none tabular-nums" style={{ color: 'var(--text)' }}>{formatSpeedIn(mbps, unit)}</div>
            <div className="mt-1 text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>
              {direction === 'upload' ? '↑ ' : direction === 'download' ? '↓ ' : ''}{speedUnitLabel(unit)}
            </div>
            <div className="mt-1 w-full truncate text-center text-[11.5px] font-semibold" style={{ color: 'rgb(var(--accent))' }}>{phase}</div>
          </>
        )}
      </div>
      {running && (
        <div className="mx-6 mt-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${Math.round(progress * 100)}%`, background: 'rgb(var(--accent))' }} />
        </div>
      )}
    </div>
  );
};

/** Живой график скорости: загрузка и отдача разным цветом, шкала по пику. */
const SpeedTrace: React.FC<{ points: SpeedTracePoint[]; unit: SpeedDisplayUnit }> = ({ points, unit }) => {
  const geometry = speedTraceGeometry(points, 300, 44);
  if (!geometry.download && !geometry.upload) return null;
  return (
    <div className="mt-2" aria-hidden="true">
      <svg viewBox="0 0 300 44" preserveAspectRatio="none" className="w-full" style={{ height: 44 }}>
        <line x1="0" y1="42" x2="300" y2="42" stroke="var(--line)" strokeWidth="1" />
        {geometry.download && <path d={geometry.download} fill="none" stroke="rgb(var(--accent))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {geometry.upload && <path d={geometry.upload} fill="none" stroke="rgb(var(--success))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="flex items-center justify-between text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
        <span><span style={{ color: 'rgb(var(--accent))' }}>━</span> загрузка · <span style={{ color: 'rgb(var(--success))' }}>━</span> отдача</span>
        <span className="tabular-nums">пик {formatSpeedIn(geometry.max, unit)} {speedUnitLabel(unit)}</span>
      </div>
    </div>
  );
};

const MetricCard: React.FC<{ icon: React.ReactNode; label: string; value: string; unit: string; hint?: string }> = ({ icon, label, value, unit, hint }) => (
  <div className="rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
    <div className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
      {icon}{label}
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-[20px] font-black tabular-nums" style={{ color: 'var(--text)' }}>{value}</span>
      <span className="text-[10.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>{unit}</span>
    </div>
    {hint && <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{hint}</div>}
  </div>
);

export const SpeedTestView: React.FC<SpeedTestViewProps> = ({ connection, profiles, subscriptions = [], confirmationProfileId, showToast }) => {
  const [progress, setProgress] = useState<SpeedProgress>({ phase: 'select', mbps: 0, progress: 0, message: '' });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [runs, setRuns] = useState<SpeedRun[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [profileId, setProfileId] = useState<number | null>(confirmationProfileId);
  const [serverId, setServerId] = useState<string>('auto');
  const [settings, setSettings] = useSettings();
  const unit = settings.speedUnit;
  const ceiling = settings.gaugeMax;
  const lite = settings.speedLite;
  const setLite = (value: boolean) => setSettings({ speedLite: value });
  const [tuneOpen, setTuneOpen] = useState(false);
  const [trace, setTrace] = useState<SpeedTracePoint[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [autoNote, setAutoNote] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const servers = useMemo(() => availableSpeedServers({ communityEndpoint: communityEndpoint() || undefined }), []);
  const selectedServer: SpeedServer | undefined = serverId === 'auto' ? undefined : servers.find((item) => item.id === serverId);

  /** Отправляет замеры, которые не удалось сохранить раньше (сервер был недоступен). */
  const flushPending = useCallback(async () => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(SPEED_PENDING_KEY); } catch { return 0; }
    const pending = readPendingSpeedRuns(raw);
    if (!pending.length) { setPendingCount(0); return 0; }
    const failed: typeof pending = [];
    let sent = 0;
    for (const run of pending) {
      try {
        await apiFetch('/api/speed-tests', { method: 'POST', body: JSON.stringify(run) });
        sent += 1;
      } catch { failed.push(run); }
    }
    try { localStorage.setItem(SPEED_PENDING_KEY, JSON.stringify(failed)); } catch { /* приватный режим */ }
    setPendingCount(failed.length);
    return sent;
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const sent = await flushPending();
      if (sent) showToast('info', `Отправлено замеров с устройства: ${sent}`);
      const res = await apiFetch<{ runs: SpeedRun[] }>('/api/speed-tests');
      setRuns(Array.isArray(res.runs) ? res.runs : []);
    } catch (error) {
      showToast('warning', error instanceof Error ? error.message : 'История замеров недоступна');
    } finally { setLoadingHistory(false); }
  }, [showToast, flushPending]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { setProfileId(confirmationProfileId); }, [confirmationProfileId]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Автоопределение: тот же узел, что выбран для подтверждений, либо угаданный по IP.
  useEffect(() => {
    if (confirmationProfileId != null || !connection?.ip) return;
    try {
      const remembered = JSON.parse(localStorage.getItem('pulsenet.route.memory') || '{}') || {};
      const suggestion = suggestActiveNode(profiles, {
        vpnPackage: connection.vpn_package, exitIp: connection.ip, remembered,
      });
      if (suggestion) { setProfileId(suggestion.profile.id); setAutoNote(suggestion.reason); }
    } catch { /* без памяти автоопределения просто нет */ }
  }, [profiles, connection?.ip, connection?.vpn_package, confirmationProfileId]);

  /**
   * Авторитетен только системный факт VPN из Android. Догадка по IP («похоже на
   * дата-центр») маршрутом не является: иначе корпоративный прокси или браузер на
   * VPS навсегда лишали бы человека возможности записать точку отсчёта без VPN.
   * В браузере решает выбор пользователя, а догадка показывается отдельной
   * подсказкой и попадает в примечание к замеру.
   */
  const route: SpeedRun['route'] = systemSpeedRoute(connection, isNativeApp());
  const ipLooksLikeVpn = Boolean(connection?.vpn_detected) && connection?.vpn_source !== 'system';
  const activeProfile = profiles.find((profile) => profile.id === profileId) || null;
  const networkKind = connection?.connection_kind || 'unknown';
  const comparison = useMemo(() => compareConfigs(runs, networkKind === 'unknown' ? undefined : networkKind), [runs, networkKind]);
  const capGuess = result ? guessSpeedCap(result.download) : null;
  const responsiveness = bufferbloatVerdict(result?.pingMs, result?.loadedPingMs);
  const subscriptionRows = useMemo(() => subscriptionSpeedRows(runs, profiles,
    Object.fromEntries(subscriptions.map((item) => [item.id, item.name])),
    networkKind === 'unknown' ? undefined : networkKind), [runs, profiles, subscriptions, networkKind]);

  const handleProgress = useCallback((next: SpeedProgress) => {
    setProgress(next);
    if (next.phase === 'download' || next.phase === 'upload') {
      setTrace((prev) => [...prev.slice(-179), { mbps: next.mbps, phase: next.phase as 'download' | 'upload' }]);
    }
  }, []);

  const start = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    setTrace([]);
    setProgress({ phase: 'select', mbps: 0, progress: 0, message: 'Готовим замер…' });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const measurement = await runSpeedTest({
        server: selectedServer,
        communityEndpoint: communityEndpoint() || undefined,
        signal: controller.signal,
        onProgress: handleProgress,
        lite,
      });
      setResult(measurement);
      setProgress((prev) => ({ ...prev, phase: measurement.ok ? 'done' : 'error', mbps: measurement.download.mbps, progress: 1,
        message: measurement.error || 'Замер завершён' }));
      if (!measurement.ok) {
        showToast('error', measurement.error || 'Замер не состоялся');
        return;
      }
      const parsed = normalizeSpeedRunPayload({
        created_at: measurement.finishedAt,
        download_mbps: Number(measurement.download.mbps.toFixed(3)),
        upload_mbps: Number(measurement.upload.mbps.toFixed(3)),
        ping_ms: measurement.pingMs == null ? null : Number(measurement.pingMs.toFixed(1)),
        jitter_ms: measurement.jitterMs == null ? null : Number(measurement.jitterMs.toFixed(1)),
        loaded_ping_ms: measurement.loadedPingMs == null ? null : Number(measurement.loadedPingMs.toFixed(1)),
        download_bytes: measurement.download.bytes,
        upload_bytes: measurement.upload.bytes,
        server: measurement.server?.label || '',
        network_kind: networkKind,
        route: recordedSpeedRoute(measurement.route, route, Boolean(activeProfile)),
        vpn_package: connection?.vpn_package || '',
        vpn_app_name: connection?.vpn_app_name || '',
        exit_ip: connection?.ip || '',
        profile_id: activeProfile?.id ?? null,
        profile_name: activeProfile?.name || '',
        reliable: measurement.download.reliable,
        note: `${measurement.route === 'unknown' && route === 'unknown' ? 'Маршрут указан вручную. ' : ''}${measurement.aborted ? 'Остановлен вручную. ' : ''}${lite ? 'Экономный замер. ' : ''}${measurement.serverReason ? `${measurement.serverReason}. ` : ''}${measurement.download.reason}`.slice(0, 400),
      });
      if (!parsed.ok) { showToast('error', parsed.error); return; }
      try {
        const saved = await apiFetch<{ run: SpeedRun }>('/api/speed-tests', { method: 'POST', body: JSON.stringify(parsed.run) });
        setRuns((prev) => [saved.run, ...prev].slice(0, 200));
        showToast('success', `Замер сохранён: ${formatSpeedIn(saved.run.download_mbps, unit)} ↓ / ${formatSpeedIn(saved.run.upload_mbps, unit)} ↑`);
      } catch {
        // Замер уже потрачен: держим его на устройстве и отправим позже.
        try {
          const queued = queuePendingSpeedRun(localStorage.getItem(SPEED_PENDING_KEY), parsed.run);
          localStorage.setItem(SPEED_PENDING_KEY, JSON.stringify(queued));
          setPendingCount(queued.length);
        } catch { /* приватный режим — очередь недоступна */ }
        setRuns((prev) => [{ ...parsed.run, id: -Date.now() } as SpeedRun, ...prev].slice(0, 200));
        showToast('warning', 'История недоступна — замер сохранён на устройстве и отправится при следующем открытии');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress((prev) => ({ ...prev, phase: 'error', message }));
      showToast('error', message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const removeRun = async (id: number) => {
    try {
      await apiFetch(`/api/speed-tests/${id}`, { method: 'DELETE' });
      setRuns((prev) => prev.filter((run) => run.id !== id));
    } catch (error) { showToast('error', error instanceof Error ? error.message : 'Не удалось удалить замер'); }
  };

  const liveMbps = running ? progress.mbps : result?.download.mbps ?? 0;

  return (
    <div className="space-y-4">
      <SectionTitle hint="Замер как в Speedtest: несколько соединений, отбрасывание разгона и провалов">
        Скорость интернета
      </SectionTitle>

      <div className="rounded-3xl border p-3 sm:p-4" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <SpeedGauge
          mbps={liveMbps} running={running} progress={progress.progress} direction={progress.phase}
          phase={running || result ? PHASE_LABEL[progress.phase] : ''} unit={unit} ceiling={ceiling}
          idle={!running && !result} onStart={() => void start()}
        />

        {/* Кнопка сразу под шкалой: стартовать и остановить можно не прокручивая. */}
        <div className="mt-2">
          {running ? (
            <Button variant="outline" block icon={<Square className="w-4 h-4" />} onClick={() => abortRef.current?.abort()}>
              Остановить
            </Button>
          ) : result ? (
            <Button variant="primary" block icon={<Play className="w-4 h-4" />} onClick={() => void start()}>
              Замерить снова
            </Button>
          ) : null}
        </div>

        <div className="mt-2 text-center text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {running ? progress.message : `Трафик замера: до ~${Math.round((lite ? SPEED_TRAFFIC.lite : SPEED_TRAFFIC.full).download / 1024 / 1024)} МБ вниз и ~${Math.round((lite ? SPEED_TRAFFIC.lite : SPEED_TRAFFIC.full).upload / 1024 / 1024)} МБ вверх`}
        </div>

        <SpeedTrace points={trace} unit={unit} />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetricCard icon={<ArrowDown className="w-3.5 h-3.5" />} label="Загрузка" value={formatSpeedIn(result?.download.mbps, unit)} unit={speedUnitLabel(unit)}
            hint={result ? formatBytes(result.download.bytes) : undefined} />
          <MetricCard icon={<ArrowUp className="w-3.5 h-3.5" />} label="Отдача" value={formatSpeedIn(result?.upload.mbps, unit)} unit={speedUnitLabel(unit)}
            hint={result ? formatBytes(result.upload.bytes) : undefined} />
          <MetricCard icon={<Activity className="w-3.5 h-3.5" />} label="Задержка" value={result?.pingMs != null ? String(Math.round(result.pingMs)) : '—'} unit="мс"
            hint={result ? (result.loadedPingMs != null ? `под нагрузкой ${Math.round(result.loadedPingMs)} мс` : 'под нагрузкой не измерена') : undefined} />
          <MetricCard icon={<Waves className="w-3.5 h-3.5" />} label="Джиттер" value={result?.jitterMs != null ? String(Math.round(result.jitterMs)) : '—'} unit="мс" />
        </div>

        {/* Настройки замера — как в оригинале: единицы, потолок шкалы, расход. */}
        <button
          type="button"
          onClick={() => setTuneOpen((value) => !value)}
          aria-expanded={tuneOpen}
          aria-controls="speed-tune-panel"
          className="mt-3 flex w-full items-center justify-between rounded-xl border px-3 py-2 text-[11.5px] font-semibold tap"
          style={{ borderColor: 'var(--line)', color: 'var(--text-muted)' }}
        >
          <span className="inline-flex items-center gap-1.5"><SlidersHorizontal className="w-3.5 h-3.5" /> Настройки замера</span>
          <span className="text-[10.5px]">
            {speedUnitLabel(unit)} · шкала {ceiling === 'auto' ? 'авто' : unit === 'MBps' ? Math.round((ceiling / 8) * 10) / 10 : ceiling}
            {lite ? ' · экономный' : ''}
          </span>
        </button>
        {tuneOpen && (
          <div id="speed-tune-panel" className="mt-2 space-y-2.5 rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Единицы</div>
              <div className="mt-1.5 flex gap-1.5">
                {(['mbps', 'MBps'] as const).map((value) => (
                  <Chip key={value} active={unit === value} onClick={() => setSettings({ speedUnit: value })}>{speedUnitLabel(value)}</Chip>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Предел шкалы, {speedUnitLabel(unit)}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(['auto', 100, 250, 500, 1000] as const).map((value) => (
                  <Chip key={String(value)} active={ceiling === value} onClick={() => setSettings({ gaugeMax: value })}>
                    {value === 'auto' ? 'Авто' : unit === 'MBps' ? Math.round((value / 8) * 10) / 10 : value}
                  </Chip>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-2 text-[11.5px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
              <input type="checkbox" checked={lite} disabled={running} onChange={(event) => setLite(event.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-[rgb(var(--accent))]" />
              <span>Экономный замер: 9 секунд и до 33 МБ вместо 18 секунд и 160 МБ</span>
            </label>
          </div>
        )}
      </div>

      {result?.ok && (
        <Notice tone="ok">
          {speedUsageVerdict(result.download.mbps, result.upload.mbps, result.pingMs)}
          {result.download.reliable ? '' : ` · ${result.download.reason}`}
        </Notice>
      )}
      {result?.aborted && <Notice tone="warn">Замер остановлен вручную: цифра посчитана по неполной фазе и сохранена как приблизительная.</Notice>}
      {result?.ok && responsiveness.grade !== 'unknown' && (
        <Notice tone={responsiveness.grade === 'ok' ? 'ok' : responsiveness.grade === 'warn' ? 'warn' : 'bad'}>{responsiveness.text}</Notice>
      )}
      {pendingCount > 0 && (
        <Notice tone="warn">
          На устройстве ждут отправки {pendingCount} {pendingCount === 1 ? 'замер' : 'замеров'}.{' '}
          <button type="button" className="underline font-semibold" onClick={() => void loadHistory()}>Отправить сейчас</button>
        </Notice>
      )}
      {result && !result.ok && <Notice tone="bad">{result.error || 'Замер не состоялся'}</Notice>}
      {result?.ok && !result.upload.bytes && result.error && <Notice tone="warn">Отдача не измерена: {result.error}</Notice>}
      {capGuess?.capped && <Notice tone="warn">{capGuess.reason}</Notice>}

      <div className="rounded-3xl border p-4 space-y-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="text-[12.5px] font-bold">Что именно измеряется</div>
        <div className="flex flex-wrap gap-1.5">
          <Chip>{route === 'vpn' ? 'Через VPN' : route === 'direct' ? 'Напрямую, без VPN' : 'Маршрут неизвестен'}</Chip>
          <Chip>{networkKind === 'unknown' ? 'Сеть не определена' : networkKindLabel(networkKind).replace(/^./, (letter) => letter.toUpperCase())}</Chip>
          {connection?.vpn_app_name && <Chip>{connection.vpn_app_name}</Chip>}
          {connection?.ip && <Chip>IP {connection.ip}</Chip>}
        </div>
        {ipLooksLikeVpn && (
          <Notice tone="info">
            По внешнему IP выход похож на VPN, прокси или дата-центр. Система этого не подтверждает, поэтому
            маршрут берётся из вашего выбора ниже: «Без VPN» для точки отсчёта или конкретный конфиг.
          </Notice>
        )}
        {connection?.split_tunnel && (
          <Notice tone="warn">
            VPN включён, но это приложение Android пускает мимо туннеля. Такой замер показывает ваш обычный интернет.
            Добавьте «ПульсСети» в проксируемые приложения в VPN-клиенте и повторите.
          </Notice>
        )}
        <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Конфиг, который сейчас включён в VPN-клиенте
          <select
            value={profileId ?? ''}
            disabled={running}
            onChange={(event) => setProfileId(event.target.value ? Number(event.target.value) : null)}
            className="mt-1.5 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--text)' }}
          >
            <option value="">{route === 'vpn' ? 'Не указан — замер сохранится без имени конфига' : 'Без VPN (прямое подключение)'}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        {autoNote && <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{autoNote}</div>}
        <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Сервер замера
          <select
            value={serverId}
            disabled={running}
            onChange={(event) => setServerId(event.target.value)}
            className="mt-1.5 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--text)' }}
          >
            <option value="auto">Автоматически (свой сервер → Cloudflare)</option>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.label}</option>)}
          </select>
        </label>
        {result?.serverReason && (
          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>Выбор точки: {result.serverReason}</div>
        )}
        <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Чтобы сравнить конфиги, замерьте скорость без VPN, затем включайте по одному конфигу в своём клиенте и
          повторяйте замер, выбирая его в списке. Приложение не может переключать чужой VPN — Android это запрещает.
        </div>
      </div>

      <div className="rounded-3xl border p-4 space-y-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold">Какие конфиги быстрее</div>
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{speedUnitLabel(unit)}</span>
        </div>
        {comparison.ranked.length === 0 ? (
          <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Пока нет замеров. Первый замер появится здесь автоматически.</div>
        ) : (
          <div className="space-y-2">
            {!comparison.baseline && (
              <Notice tone="warn">
                {comparison.baselineOtherNetwork
                  ? `Замер без VPN есть, но на другой сети (${networkKindLabel(comparison.baselineOtherNetwork.networkKind)}). Сейчас ${networkKindLabel(networkKind)} — сравните на одной сети, иначе разница покажет смену канала, а не потери конфига.`
                  : 'Нет замера без VPN на этой сети — сравнить потери скорости пока нельзя. Выключите VPN и нажмите «Замерить».'}
              </Notice>
            )}
            {comparison.ranked.map((item, index) => {
              const verdict = comparison.verdicts.find((entry) => entry.key === item.key);
              return (
                <div key={item.key} className="rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-bold truncate">{index === 0 ? '🏆 ' : ''}{item.label}</div>
                    <div className="text-[12px] font-black tabular-nums shrink-0">{formatSpeedIn(item.medianDownload, unit)} ↓</div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{formatSpeedIn(item.medianUpload, unit)} ↑</span>
                    {item.medianPing != null && <span>{Math.round(item.medianPing)} мс</span>}
                    {item.medianLoadedPing != null && <span>под нагрузкой {Math.round(item.medianLoadedPing)} мс</span>}
                    <span>лучший {formatSpeedIn(item.bestDownload, unit)}</span>
                    <span>{item.runs} {item.runs === 1 ? 'замер' : 'замеров'}</span>
                    <span>{new Date(item.lastAt).toLocaleString('ru-RU')}</span>
                  </div>
                  {verdict && (comparison.baseline || item.key === 'direct') && (
                    <div className="mt-1 text-[10.5px] font-semibold" style={{ color: verdict.tone === 'ok' ? 'rgb(var(--success))' : verdict.tone === 'bad' ? 'rgb(var(--danger))' : 'rgb(var(--warning))' }}>
                      {verdict.text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {subscriptionRows.length > 0 && (
        <div className="rounded-3xl border p-4 space-y-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <div className="text-[12.5px] font-bold">Подписки: где теряется скорость</div>
          <div className="space-y-2">
            {subscriptionRows.map((row) => (
              <div key={row.key} className="rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12px] font-bold truncate">{row.label}</div>
                  <div className="text-[12px] font-black tabular-nums shrink-0">{formatSpeedIn(row.medianMbps, unit)} ↓</div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  <span>измерено {row.measured} из {row.totalConfigs}</span>
                  {row.bestMbps != null && <span>лучший {formatSpeedIn(row.bestMbps, unit)}</span>}
                  {row.worstMbps != null && <span>худший {formatSpeedIn(row.worstMbps, unit)}</span>}
                  {row.medianLoadedPing != null && <span>под нагрузкой {Math.round(row.medianLoadedPing)} мс</span>}
                </div>
                <div className="mt-1 text-[10.5px] font-semibold" style={{
                  color: !comparison.baseline ? 'var(--text-muted)' : row.limiting ? 'rgb(var(--danger))' : row.slowing ? 'rgb(var(--warning))' : 'rgb(var(--success))',
                }}>
                  {!comparison.baseline ? 'Нужен замер без VPN на этой сети — тогда будет видно, какие конфиги режут канал'
                    : row.limiting ? `Режут канал: ${row.limiting} ${row.limiting === 1 ? 'конфиг' : 'конфигов'} ниже половины прямого канала`
                    : row.slowing ? `Проседают: ${row.slowing} ${row.slowing === 1 ? 'конфиг' : 'конфигов'}`
                    : 'Все измеренные конфиги держат скорость'}
                </div>
              </div>
            ))}
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            Считаются только замеры на текущем типе сети. Неизмеренные конфиги в статистику не попадают.
          </div>
        </div>
      )}

      <div className="rounded-3xl border p-4 space-y-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold">История замеров</div>
          <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{speedUnitLabel(unit)}</span>
        </div>
        {loadingHistory ? (
          <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Загружаем…</div>
        ) : runs.length === 0 ? (
          <EmptyState icon={<Gauge className="w-6 h-6" />} title="Замеров пока нет" text="Нажмите «Замерить» — результат сохранится на устройстве" />
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {runs.slice(0, 20).map((run) => (
              <div key={run.id} className="py-2 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] font-bold truncate">
                    {formatSpeedIn(run.download_mbps, unit)} ↓ · {formatSpeedIn(run.upload_mbps, unit)} ↑
                    {run.ping_ms != null ? ` · ${Math.round(run.ping_ms)} мс` : ''}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {new Date(run.created_at).toLocaleString('ru-RU')} · {run.profile_name || (run.route === 'vpn' ? 'VPN без имени' : 'без VPN')} · {run.server || 'сервер не указан'}
                    {run.reliable === false ? ' · приблизительно' : ''}
                  </div>
                </div>
                <button onClick={() => void removeRun(run.id)} className="tap-icon tap shrink-0" style={{ color: 'var(--text-muted)' }} aria-label="Удалить замер">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Notice tone="info">
        <span className="inline-flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Методика: 2–8 параллельных соединений, отбрасывание разгона TCP, 20 срезов, минус 10% самых быстрых и 30% самых
            медленных — как считает Speedtest. Результат описывает канал до выбранного сервера, а не скорость конкретного сайта.
          </span>
        </span>
      </Notice>
    </div>
  );
};
