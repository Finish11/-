import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Activity, Gauge, Info, Play, Square, Trash2, Waves } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { communityEndpoint } from '../lib/community';
import { isNativeApp } from '../lib/nativeBridge';
import { routeFingerprint, suggestActiveNode } from '../lib/appConfirmations';
import { runSpeedTest, SPEED_TRAFFIC, type SpeedProgress, type SpeedTestResult } from '../lib/speedRunner';
import { availableSpeedServers, type SpeedServer } from '../lib/speedEndpoints';
import {
  compareConfigs, formatBytes, formatSpeed, guessSpeedCap, speedGaugeFraction, speedTraceGeometry, speedUsageVerdict,
  GAUGE_TICKS, type SpeedRun, type SpeedTracePoint,
} from '../lib/speedTest';
import type { ClientConnectionInfo, VpnProfile } from '../types';
import { Button, Chip, EmptyState, Notice, SectionTitle } from './ui/kit';

interface SpeedTestViewProps {
  connection: ClientConnectionInfo | null;
  profiles: VpnProfile[];
  confirmationProfileId: number | null;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const PHASE_LABEL: Record<SpeedProgress['phase'], string> = {
  select: 'Выбор сервера', ping: 'Задержка', warmup: 'Разогрев',
  download: 'Загрузка', upload: 'Отдача', done: 'Готово', error: 'Ошибка',
};

/** Стрелка и дуга: логарифмическая шкала, как в Speedtest. */
const SpeedGauge: React.FC<{ mbps: number; running: boolean; phase: string; progress: number; direction?: string }> = ({ mbps, running, phase, progress, direction }) => {
  const fraction = speedGaugeFraction(mbps);
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
  const needle = polar(angle, radius - 22);
  return (
    <div className="relative mx-auto" style={{ width: 260, height: 232 }}>
      <svg viewBox="0 0 260 232" className="w-full h-full">
        <path d={arc(startAngle, startAngle + sweep, radius)} fill="none" stroke="var(--surface-2)" strokeWidth="14" strokeLinecap="round" />
        <path
          d={arc(startAngle, startAngle + Math.max(0.6, sweep * fraction), radius)}
          fill="none" stroke="rgb(var(--accent))" strokeWidth="14" strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.3s ease' }}
        />
        {GAUGE_TICKS.map((tick) => {
          const tickFraction = speedGaugeFraction(tick);
          const tickAngle = startAngle + sweep * tickFraction;
          const outer = polar(tickAngle, radius - 12);
          const inner = polar(tickAngle, radius - 22);
          const label = polar(tickAngle, radius - 36);
          return (
            <g key={tick}>
              <line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke="var(--line)" strokeWidth="2" />
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="var(--text-muted)">{tick}</text>
            </g>
          );
        })}
        <line
          x1={center} y1={center} x2={needle.x} y2={needle.y}
          stroke={running ? 'rgb(var(--accent))' : 'var(--text-muted)'} strokeWidth="3.5" strokeLinecap="round"
          style={{ transition: 'all 0.35s cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
        <circle cx={center} cy={center} r="7" fill="var(--surface)" stroke="var(--line)" strokeWidth="2" />
      </svg>
      <div className="absolute inset-x-0 text-center" style={{ top: 138 }}>
        <div className="text-[34px] font-black leading-none tabular-nums" style={{ color: 'var(--text)' }}>{formatSpeed(mbps)}</div>
        <div className="text-[11px] font-bold mt-1" style={{ color: 'var(--text-muted)' }}>
          {direction === 'upload' ? '↑ ' : direction === 'download' ? '↓ ' : ''}Мбит/с
        </div>
        <div className="text-[11.5px] font-semibold mt-1.5" style={{ color: 'rgb(var(--accent))' }}>{phase}</div>
      </div>
      {running && (
        <div className="absolute inset-x-6 bottom-0 h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${Math.round(progress * 100)}%`, background: 'rgb(var(--accent))' }} />
        </div>
      )}
    </div>
  );
};

/** Живой график скорости: загрузка и отдача разным цветом, шкала по пику. */
const SpeedTrace: React.FC<{ points: SpeedTracePoint[] }> = ({ points }) => {
  const geometry = speedTraceGeometry(points, 300, 44);
  if (!geometry.download && !geometry.upload) return null;
  return (
    <div className="mt-2" aria-hidden="true">
      <svg viewBox="0 0 300 44" className="w-full" style={{ height: 44 }}>
        <line x1="0" y1="42" x2="300" y2="42" stroke="var(--line)" strokeWidth="1" />
        {geometry.download && <path d={geometry.download} fill="none" stroke="rgb(var(--accent))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {geometry.upload && <path d={geometry.upload} fill="none" stroke="rgb(var(--success))" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      </svg>
      <div className="flex items-center justify-between text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
        <span><span style={{ color: 'rgb(var(--accent))' }}>━</span> загрузка · <span style={{ color: 'rgb(var(--success))' }}>━</span> отдача</span>
        <span className="tabular-nums">пик {formatSpeed(geometry.max)}</span>
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

export const SpeedTestView: React.FC<SpeedTestViewProps> = ({ connection, profiles, confirmationProfileId, showToast }) => {
  const [progress, setProgress] = useState<SpeedProgress>({ phase: 'select', mbps: 0, progress: 0, message: '' });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [runs, setRuns] = useState<SpeedRun[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [profileId, setProfileId] = useState<number | null>(confirmationProfileId);
  const [serverId, setServerId] = useState<string>('auto');
  const [lite, setLite] = useState(false);
  const [trace, setTrace] = useState<SpeedTracePoint[]>([]);
  const [autoNote, setAutoNote] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const servers = useMemo(() => availableSpeedServers({ communityEndpoint: communityEndpoint() || undefined }), []);
  const selectedServer: SpeedServer | undefined = serverId === 'auto' ? undefined : servers.find((item) => item.id === serverId);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch<{ runs: SpeedRun[] }>('/api/speed-tests');
      setRuns(Array.isArray(res.runs) ? res.runs : []);
    } catch (error) {
      showToast('warning', error instanceof Error ? error.message : 'История замеров недоступна');
    } finally { setLoadingHistory(false); }
  }, [showToast]);

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

  const route: SpeedRun['route'] = connection?.vpn_detected ? 'vpn' : isNativeApp() ? 'direct' : 'unknown';
  const activeProfile = profiles.find((profile) => profile.id === profileId) || null;
  const networkKind = connection?.connection_kind || 'unknown';
  const comparison = useMemo(() => compareConfigs(runs, networkKind === 'unknown' ? undefined : networkKind), [runs, networkKind]);
  const capGuess = result ? guessSpeedCap(result.download) : null;

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
      const payload = {
        created_at: measurement.finishedAt,
        download_mbps: Number(measurement.download.mbps.toFixed(3)),
        upload_mbps: Number(measurement.upload.mbps.toFixed(3)),
        ping_ms: measurement.pingMs == null ? null : Number(measurement.pingMs.toFixed(1)),
        jitter_ms: measurement.jitterMs == null ? null : Number(measurement.jitterMs.toFixed(1)),
        download_bytes: measurement.download.bytes,
        upload_bytes: measurement.upload.bytes,
        server: measurement.server?.label || '',
        network_kind: networkKind,
        route: measurement.route !== 'unknown' ? measurement.route : route,
        vpn_package: connection?.vpn_package || '',
        vpn_app_name: connection?.vpn_app_name || '',
        exit_ip: connection?.ip || '',
        profile_id: activeProfile?.id ?? null,
        profile_name: activeProfile?.name || '',
        reliable: measurement.download.reliable,
        note: `${lite ? 'Экономный замер. ' : ''}${measurement.download.reason}`,
      };
      const saved = await apiFetch<{ run: SpeedRun }>('/api/speed-tests', { method: 'POST', body: JSON.stringify(payload) });
      setRuns((prev) => [saved.run, ...prev].slice(0, 200));
      showToast('success', `Замер сохранён: ${formatSpeed(saved.run.download_mbps)} ↓ / ${formatSpeed(saved.run.upload_mbps)} ↑`);
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

      <div className="rounded-3xl border p-4" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <SpeedGauge mbps={liveMbps} running={running} phase={running || result ? PHASE_LABEL[progress.phase] : 'Нажмите «Замерить»'} progress={progress.progress} direction={progress.phase} />

        <SpeedTrace points={trace} />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetricCard icon={<ArrowDown className="w-3.5 h-3.5" />} label="Загрузка" value={formatSpeed(result?.download.mbps)} unit="Мбит/с"
            hint={result ? formatBytes(result.download.bytes) : undefined} />
          <MetricCard icon={<ArrowUp className="w-3.5 h-3.5" />} label="Отдача" value={formatSpeed(result?.upload.mbps)} unit="Мбит/с"
            hint={result ? formatBytes(result.upload.bytes) : undefined} />
          <MetricCard icon={<Activity className="w-3.5 h-3.5" />} label="Задержка" value={result?.pingMs != null ? String(Math.round(result.pingMs)) : '—'} unit="мс" />
          <MetricCard icon={<Waves className="w-3.5 h-3.5" />} label="Джиттер" value={result?.jitterMs != null ? String(Math.round(result.jitterMs)) : '—'} unit="мс" />
        </div>

        <div className="mt-3">
          {running ? (
            <Button variant="outline" block icon={<Square className="w-4 h-4" />} onClick={() => abortRef.current?.abort()}>
              Остановить
            </Button>
          ) : (
            <Button variant="primary" block icon={<Play className="w-4 h-4" />} onClick={() => void start()}>
              Замерить
            </Button>
          )}
        </div>

        <label className="mt-3 flex items-center gap-2 text-[11.5px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={lite} disabled={running} onChange={(event) => setLite(event.target.checked)} className="w-4 h-4 accent-[rgb(var(--accent))]" />
          Экономный замер (меньше трафика, чуть ниже точность)
        </label>
        <div className="mt-1.5 text-[10.5px] leading-relaxed text-center" style={{ color: 'var(--text-muted)' }}>
          {running ? progress.message : `Замер передаёт реальные данные: до ~${Math.round((lite ? SPEED_TRAFFIC.lite : SPEED_TRAFFIC.full).download / 1024 / 1024)} МБ на загрузку и ~${Math.round((lite ? SPEED_TRAFFIC.lite : SPEED_TRAFFIC.full).upload / 1024 / 1024)} МБ на отдачу. На мобильном интернете учитывайте тариф.`}
        </div>
      </div>

      {result?.ok && (
        <Notice tone="ok">
          {speedUsageVerdict(result.download.mbps, result.upload.mbps, result.pingMs)}
          {result.download.reliable ? '' : ` · ${result.download.reason}`}
        </Notice>
      )}
      {result && !result.ok && <Notice tone="bad">{result.error || 'Замер не состоялся'}</Notice>}
      {result?.ok && !result.upload.bytes && result.error && <Notice tone="warn">Отдача не измерена: {result.error}</Notice>}
      {capGuess?.capped && <Notice tone="warn">{capGuess.reason}</Notice>}

      <div className="rounded-3xl border p-4 space-y-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="text-[12.5px] font-bold">Что именно измеряется</div>
        <div className="flex flex-wrap gap-1.5">
          <Chip>{route === 'vpn' ? 'Через VPN' : route === 'direct' ? 'Напрямую, без VPN' : 'Маршрут неизвестен'}</Chip>
          <Chip>{networkKind === 'wifi' ? 'Wi-Fi' : networkKind === 'cellular' ? 'Мобильная сеть' : networkKind === 'ethernet' ? 'Проводная' : 'Сеть не определена'}</Chip>
          {connection?.vpn_app_name && <Chip>{connection.vpn_app_name}</Chip>}
          {connection?.ip && <Chip>IP {connection.ip}</Chip>}
        </div>
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
        <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Чтобы сравнить конфиги, замерьте скорость без VPN, затем включайте по одному конфигу в своём клиенте и
          повторяйте замер, выбирая его в списке. Приложение не может переключать чужой VPN — Android это запрещает.
        </div>
      </div>

      <div className="rounded-3xl border p-4 space-y-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="text-[12.5px] font-bold">Какие конфиги быстрее</div>
        {comparison.ranked.length === 0 ? (
          <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Пока нет замеров. Первый замер появится здесь автоматически.</div>
        ) : (
          <div className="space-y-2">
            {!comparison.baseline && <Notice tone="warn">Нет замера без VPN на этой сети — сравнить потери скорости пока нельзя.</Notice>}
            {comparison.ranked.map((item, index) => {
              const verdict = comparison.verdicts.find((entry) => entry.key === item.key);
              return (
                <div key={item.key} className="rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-bold truncate">{index === 0 ? '🏆 ' : ''}{item.label}</div>
                    <div className="text-[12px] font-black tabular-nums shrink-0">{formatSpeed(item.medianDownload)} ↓</div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{formatSpeed(item.medianUpload)} ↑</span>
                    {item.medianPing != null && <span>{Math.round(item.medianPing)} мс</span>}
                    <span>лучший {formatSpeed(item.bestDownload)}</span>
                    <span>{item.runs} {item.runs === 1 ? 'замер' : 'замеров'}</span>
                    <span>{new Date(item.lastAt).toLocaleString('ru-RU')}</span>
                  </div>
                  {verdict && (
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

      <div className="rounded-3xl border p-4 space-y-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="text-[12.5px] font-bold">История замеров</div>
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
                    {formatSpeed(run.download_mbps)} ↓ · {formatSpeed(run.upload_mbps)} ↑
                    {run.ping_ms != null ? ` · ${Math.round(run.ping_ms)} мс` : ''}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {new Date(run.created_at).toLocaleString('ru-RU')} · {run.profile_name || (run.route === 'vpn' ? 'VPN без имени' : 'без VPN')} · {run.server || 'сервер не указан'}
                    {run.reliable === false ? ' · приблизительно' : ''}
                  </div>
                </div>
                <button onClick={() => void removeRun(run.id)} className="p-1.5 rounded-lg shrink-0" style={{ color: 'var(--text-muted)' }} aria-label="Удалить замер">
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
