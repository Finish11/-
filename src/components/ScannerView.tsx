import React, { useEffect, useRef, useState } from 'react';
import {
  Radar,
  ShieldAlert,
  ShieldCheck,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  Check,
  Send,
  ChevronDown,
  ChevronUp,
  Sparkles,
  PowerOff,
  Play,
  RefreshCw,
  HelpCircle,
  Lock,
  Activity,
  Server,
  Eye,
} from 'lucide-react';
import {
  CATEGORY_META,
  type ClientConnectionInfo,
  type ScanRecord,
  type ScanSiteResult,
  type SimulationMode,
  type Site,
  type SiteCategory,
  type User,
} from '../types';
import {
  detectCurrentConnection,
  diagnoseScan,
  evaluateScanVerdict,
  IS_DEMO_BUILD,
  runMultiSiteScan,
} from '../lib/scanner';
import { apiFetch } from '../lib/api';
import { QuickPicks } from './QuickPicks';

interface ScannerViewProps {
  user: User;
  sites: Site[];
  latestScan: ScanRecord | null;
  connection: ClientConnectionInfo | null;
  onConnectionDetected: (c: ClientConnectionInfo) => void;
  onScanSaved: (scan: ScanRecord) => void;
  onQuickReportIncident: (scan: ScanRecord) => void;
  onNavigateSites: () => void;
  /** Перечитать каталог после «быстрого выбора» сервисов. */
  onSitesChanged: () => void;
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  user,
  sites,
  latestScan,
  connection,
  onConnectionDetected,
  onScanSaved,
  onQuickReportIncident,
  onNavigateSites,
  onSitesChanged,
  darkMode,
  showToast,
}) => {
  const [simMode, setSimMode] = useState<SimulationMode>(IS_DEMO_BUILD ? 'sim_whitelist' : 'live');
  const [phase, setPhase] = useState<
    'idle' | 'precheck' | 'vpn_prompt' | 'waiting_vpn_off' | 'scanning' | 'done'
  >('idle');

  const [detectedConn, setDetectedConn] = useState<ClientConnectionInfo | null>(connection);
  const [progress, setProgress] = useState({ done: 0, total: 0, currentDomain: '' });
  const [liveResults, setLiveResults] = useState<ScanSiteResult[]>([]);
  const [activeScan, setActiveScan] = useState<ScanRecord | null>(latestScan);

  const [siteFilter, setSiteFilter] = useState<'all' | 'blocked' | 'ok' | SiteCategory>('all');
  const [copiedReport, setCopiedReport] = useState(false);
  const [showTips, setShowTips] = useState(false);
  const [quickNote, setQuickNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const vpnWatchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (connection && phase === 'idle') {
      setDetectedConn(connection);
    }
  }, [connection, phase]);

  useEffect(() => {
    if (!activeScan && latestScan) {
      setActiveScan(latestScan);
    }
  }, [latestScan, activeScan]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (vpnWatchTimerRef.current) window.clearInterval(vpnWatchTimerRef.current);
    };
  }, []);

  const enabledSitesCount = sites.filter((s) => Boolean(s.enabled)).length;

  // Step 1: User presses main button "ПРОВЕРИТЬ СЕТЬ"
  const handleStartCheck = async () => {
    if (enabledSitesCount === 0) {
      showToast('warning', 'Нет включённых сайтов для проверки. Включите или добавьте сайты в каталоге.');
      onNavigateSites();
      return;
    }

    if (vpnWatchTimerRef.current) {
      window.clearInterval(vpnWatchTimerRef.current);
      vpnWatchTimerRef.current = null;
    }

    setPhase('precheck');
    const conn = await detectCurrentConnection(simMode);
    setDetectedConn(conn);
    onConnectionDetected(conn);

    // If VPN is ON -> warn the user and let them choose: Turn off VPN OR Check access with VPN!
    if (conn.vpn_detected) {
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
      setPhase('vpn_prompt');
      return;
    }

    // Otherwise run full scan immediately
    await executeSiteScan(conn, simMode === 'live' ? 'direct' : 'simulated', simMode);
  };

  // Option A from VPN Modal: Watch for user turning VPN OFF (plus manual button to proceed immediately)
  const handleWaitForVpnOff = () => {
    setPhase('waiting_vpn_off');
    if (vpnWatchTimerRef.current) window.clearInterval(vpnWatchTimerRef.current);

    // If user was in sim_vpn mode, switching VPN off switches to live (or clean carrier check)
    if (simMode === 'sim_vpn') {
      setSimMode('live');
    }

    vpnWatchTimerRef.current = window.setInterval(async () => {
      const fresh = await detectCurrentConnection('live');
      setDetectedConn(fresh);
      onConnectionDetected(fresh);
      if (!fresh.vpn_detected) {
        if (vpnWatchTimerRef.current) {
          window.clearInterval(vpnWatchTimerRef.current);
          vpnWatchTimerRef.current = null;
        }
        showToast('success', `VPN отключён (${fresh.isp}). Запускаем чистую проверку сети!`);
        executeSiteScan(fresh, 'vpn_turned_off', 'live');
      }
    }, 2600);
  };

  const handleConfirmTurnedOffNow = async () => {
    if (vpnWatchTimerRef.current) {
      window.clearInterval(vpnWatchTimerRef.current);
      vpnWatchTimerRef.current = null;
    }
    setPhase('precheck');
    const nextMode = simMode === 'sim_vpn' ? 'sim_whitelist' : simMode;
    const fresh = await detectCurrentConnection(simMode === 'sim_vpn' ? 'live' : nextMode);
    setDetectedConn(fresh);
    onConnectionDetected(fresh);
    await executeSiteScan(fresh, 'vpn_turned_off', simMode === 'sim_vpn' ? 'live' : nextMode);
  };

  // Option B from VPN Modal: Check availability WITH active VPN
  const handleProceedWithVpn = async () => {
    if (vpnWatchTimerRef.current) {
      window.clearInterval(vpnWatchTimerRef.current);
      vpnWatchTimerRef.current = null;
    }
    if (!detectedConn) return;
    await executeSiteScan(detectedConn, 'with_vpn', simMode);
  };

  // Шаг 2: параллельная проверка всех включённых сайтов (по умолчанию 75)
  const executeSiteScan = async (
    conn: ClientConnectionInfo,
    vpnMode: 'direct' | 'with_vpn' | 'vpn_turned_off' | 'simulated',
    effectiveSimMode: SimulationMode
  ) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setPhase('scanning');
    setLiveResults([]);
    setSiteFilter('all');
    setProgress({ done: 0, total: enabledSitesCount, currentDomain: '' });

    const results = await runMultiSiteScan(
      sites,
      effectiveSimMode,
      (done, total, latest, partial) => {
        setProgress({ done, total, currentDomain: latest.domain });
        setLiveResults([...partial]);
      },
      ctrl.signal
    );

    if (ctrl.signal.aborted) return;

    const sitesMap = new Map<number, Site>(sites.map((site) => [site.id, site]));
    const evaluated = evaluateScanVerdict(results, vpnMode === 'with_vpn', sitesMap);
    const carrierLabel =
      vpnMode === 'with_vpn'
        ? `VPN • ${conn.country_name}${conn.city ? `, ${conn.city}` : ''}`
        : `${conn.isp || user.carrier} • ${conn.city || user.region}`;

    try {
      const saved = await apiFetch<{ scan: ScanRecord }>('/api/scans', {
        method: 'POST',
        body: JSON.stringify({
          ...evaluated,
          vpn_detected: conn.vpn_detected && vpnMode === 'with_vpn',
          vpn_mode: vpnMode,
          ip_address: conn.ip,
          country_code: conn.country_code,
          country_name: conn.country_name,
          city: conn.city,
          isp: conn.isp,
          asn: conn.asn,
          carrier_label: carrierLabel,
          note: '',
          results,
        }),
      });
      setActiveScan(saved.scan);
      setQuickNote('');
      onScanSaved(saved.scan);
    } catch {
      // Fallback local display if offline during total shutdown!
      const localScan: ScanRecord = {
        id: Date.now(),
        user_id: user.id,
        ...evaluated,
        vpn_detected: conn.vpn_detected && vpnMode === 'with_vpn',
        vpn_mode: vpnMode,
        ip_address: conn.ip,
        country_code: conn.country_code,
        country_name: conn.country_name,
        city: conn.city,
        isp: conn.isp,
        asn: conn.asn,
        carrier_label: carrierLabel,
        note: 'Сохранено локально (сервер временно недоступен)',
        pinned: false,
        results,
        created_at: new Date().toISOString(),
      };
      setActiveScan(localScan);
    }

    if (navigator.vibrate) {
      if (evaluated.verdict === 'WHITELIST_ACTIVE' || evaluated.verdict === 'TOTAL_JAMMING') {
        navigator.vibrate([100, 60, 140]);
      } else {
        navigator.vibrate(50);
      }
    }

    setPhase('done');
  };

  const handleCancelScan = () => {
    abortRef.current?.abort();
    if (vpnWatchTimerRef.current) {
      window.clearInterval(vpnWatchTimerRef.current);
      vpnWatchTimerRef.current = null;
    }
    setPhase('idle');
  };

  const handleSaveQuickNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeScan || !quickNote.trim()) return;
    setSavingNote(true);
    try {
      const res = await apiFetch<{ scan: ScanRecord }>(`/api/scans/${activeScan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: quickNote.trim() }),
      });
      setActiveScan(res.scan);
      onScanSaved(res.scan);
      setQuickNote('');
      showToast('success', 'Заметка прикреплена к замеру');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось сохранить заметку');
    } finally {
      setSavingNote(false);
    }
  };

  const handleCopyTelegramReport = async () => {
    if (!activeScan) return;
    const emoji =
      activeScan.verdict === 'WHITELIST_ACTIVE'
        ? '🔴'
        : activeScan.verdict === 'TOTAL_JAMMING'
        ? '🚨'
        : activeScan.verdict === 'SEVERE_RESTRICTIONS'
        ? '🟠'
        : activeScan.verdict === 'DPI_THROTTLING'
        ? '🟡'
        : '🟢';

    const text = [
      `${emoji} ПульсСети — Диагностика интернета`,
      `Вердикт: ${activeScan.verdict_title}`,
      `Сеть: ${activeScan.carrier_label} (${activeScan.country_code})`,
      `VPN при проверке: ${activeScan.vpn_detected ? 'Включён' : 'Выключен'}`,
      `Доступно сайтов: ${activeScan.ok_sites + activeScan.slow_sites} из ${activeScan.total_sites}`,
      `• Сайты РФ (белый список): ${activeScan.ru_ok_pct}%`,
      `• Глобальные / CDN: ${activeScan.global_ok_pct}%`,
      `• Видео и соцсети (DPI): ${activeScan.dpi_ok_pct}%`,
      `Средний пинг: ${activeScan.avg_latency_ms} мс`,
      `Время: ${new Date(activeScan.created_at).toLocaleString('ru-RU')}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopiedReport(true);
      showToast('success', 'Отчёт скопирован! Можно вставить в Telegram или чат');
      setTimeout(() => setCopiedReport(false), 2500);
    } catch {
      showToast('error', 'Не удалось скопировать в буфер обмена');
    }
  };

  // Compute displayed results (live during scan, or activeScan when idle/done)
  const displayedResults =
    phase === 'scanning' ? liveResults : activeScan?.results || [];

  const filteredResults = displayedResults.filter((r) => {
    if (siteFilter === 'all') return true;
    if (siteFilter === 'blocked') return r.status === 'blocked';
    if (siteFilter === 'ok') return r.status === 'ok' || r.status === 'slow';
    return r.category === siteFilter;
  });

  // Group stats by category
  const categoryStats = (Object.keys(CATEGORY_META) as SiteCategory[])
    .map((catKey) => {
      const items = displayedResults.filter((r) => r.category === catKey);
      const okCount = items.filter((r) => r.status === 'ok' || r.status === 'slow').length;
      return {
        key: catKey,
        meta: CATEGORY_META[catKey],
        total: items.length,
        ok: okCount,
        pct: items.length > 0 ? Math.round((okCount / items.length) * 100) : 0,
      };
    })
    .filter((c) => c.total > 0);

  // Три группы ресурсов: перечень Минцифры / нейтральные / заблокированные РКН
  const roleGroups = (() => {
    const sitesMap = new Map<number, Site>(sites.map((site) => [site.id, site]));
    const groupOf = (r: ScanSiteResult) => {
      const site = r.site_id ? sitesMap.get(r.site_id) : undefined;
      if (site) {
        if (site.marker_role === 'ru_whitelist' || site.category === 'ru_whitelist') return 'ru';
        if (site.marker_role === 'dpi_target') return 'blocked';
        return 'neutral';
      }
      if (r.marker_role === 'ru_whitelist' || r.category === 'ru_whitelist') return 'ru';
      if (r.marker_role === 'dpi_target') return 'blocked';
      return 'neutral';
    };
    const reach = (r: ScanSiteResult) => r.status === 'ok' || r.status === 'slow';
    const build = (key: 'ru' | 'neutral' | 'blocked') => {
      const items = displayedResults.filter((r) => groupOf(r) === key);
      const alive = items.filter(reach);
      return {
        items,
        total: items.length,
        ok: alive.length,
        pct: items.length ? Math.round((alive.length / items.length) * 100) : 0,
        blockedList: items.filter((r) => !reach(r)),
      };
    };
    return { ru: build('ru'), neutral: build('neutral'), blocked: build('blocked') };
  })();

  const verdictTheme = (verdict?: string) => {
    switch (verdict) {
      case 'WHITELIST_ACTIVE':
      case 'TOTAL_JAMMING':
        return {
          card: darkMode
            ? 'bg-gradient-to-br from-rose-950/90 via-rose-950/50 to-slate-900 border-rose-500/50 shadow-rose-950/40'
            : 'bg-rose-50 border-rose-300',
          badge: 'bg-rose-500 text-white',
          iconColor: 'text-rose-400',
          Icon: WifiOff,
        };
      case 'SEVERE_RESTRICTIONS':
        return {
          card: darkMode
            ? 'bg-gradient-to-br from-orange-950/80 via-slate-900 to-slate-900 border-orange-500/45'
            : 'bg-orange-50 border-orange-300',
          badge: 'bg-orange-500 text-slate-950',
          iconColor: 'text-orange-400',
          Icon: AlertTriangle,
        };
      case 'DPI_THROTTLING':
        return {
          card: darkMode
            ? 'bg-gradient-to-br from-amber-950/65 via-slate-900 to-slate-900 border-amber-500/40'
            : 'bg-amber-50 border-amber-300',
          badge: 'bg-amber-400 text-slate-950',
          iconColor: 'text-amber-400',
          Icon: ShieldAlert,
        };
      default:
        return {
          card: darkMode
            ? 'bg-gradient-to-br from-emerald-950/65 via-slate-900 to-slate-900 border-emerald-500/40'
            : 'bg-emerald-50 border-emerald-300',
          badge: 'bg-emerald-500 text-slate-950',
          iconColor: 'text-emerald-400',
          Icon: ShieldCheck,
        };
    }
  };

  const vStyle = verdictTheme(activeScan?.verdict);
  const VerdictIcon = vStyle.Icon;

  return (
    <div className="space-y-6">
      {/* ==================== DIAGNOSTIC MODE TOOLBAR ==================== */}
      <div
        className={`p-3 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
          darkMode
            ? 'bg-slate-900/70 border-slate-800/80'
            : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        <div className="flex items-center gap-2 text-xs">
          <Sparkles className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="font-semibold">Режим проверки:</span>
          <span className="text-slate-400 hidden 2xl:inline">
            «Живая сеть» проверяет ваш реальный интернет на телефоне; пресеты позволяют протестировать сценарии
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pb-0.5 lg:justify-end">
          {(
            [
              { id: 'live', label: '📡 Живая сеть' },
              { id: 'sim_whitelist', label: '🔴 Тест: Белые списки' },
              { id: 'sim_vpn', label: '🛡️ Тест: С VPN' },
              { id: 'sim_dpi', label: '🟡 Тест: ТСПУ' },
              { id: 'sim_jamming', label: '📵 Тест: Глушение' },
            ] as Array<{ id: SimulationMode; label: string }>
          ).map((m) => (
            <button
              key={m.id}
              disabled={phase === 'scanning' || phase === 'precheck'}
              onClick={() => setSimMode(m.id)}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                simMode === m.id
                  ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-sm'
                  : darkMode
                  ? 'bg-slate-950/80 text-slate-400 border-slate-800 hover:text-slate-200'
                  : 'bg-slate-100 text-slate-600 border-slate-200 hover:text-slate-900'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* ==================== HERO MOBILE-FIRST RADAR BUTTON CARD ==================== */}
      <div
        className={`relative overflow-hidden rounded-3xl border p-6 sm:p-8 text-center transition-all ${
          darkMode
            ? 'bg-gradient-to-b from-slate-900/95 via-slate-900/80 to-slate-950 border-slate-800/90 shadow-2xl'
            : 'bg-gradient-to-b from-white to-slate-50 border-slate-200 shadow-xl'
        }`}
      >
        {/* Ambient glow */}
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full blur-3xl pointer-events-none transition-colors duration-700 ${
            phase === 'scanning' || phase === 'precheck'
              ? 'bg-sky-500/20'
              : activeScan?.verdict === 'WHITELIST_ACTIVE' || activeScan?.verdict === 'TOTAL_JAMMING'
              ? 'bg-rose-500/15'
              : 'bg-sky-500/10'
          }`}
        />

        <div className="relative z-10 max-w-xl mx-auto flex flex-col items-center">
          {/* Top Connection Pill */}
          <div
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium border mb-6 ${
              detectedConn?.vpn_detected
                ? 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                : darkMode
                ? 'bg-slate-950/80 border-slate-800 text-slate-300'
                : 'bg-slate-100 border-slate-200 text-slate-700'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                detectedConn?.vpn_detected ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
              }`}
            />
            {detectedConn ? (
              <span>
                {detectedConn.vpn_detected ? 'Обнаружен VPN: ' : 'Ваша сеть: '}
                <strong className="font-semibold">
                  {detectedConn.country_name} • {detectedConn.isp}
                </strong>{' '}
                <span className="font-mono opacity-75">({detectedConn.ip})</span>
              </span>
            ) : (
              <span>Готов к проверке {enabledSitesCount} сайтов и VPN</span>
            )}
          </div>

          {/* BIG TACTILE 1-TAP RADAR BUTTON */}
          <div className="relative my-2 flex items-center justify-center">
            {(phase === 'scanning' || phase === 'precheck') && (
              <>
                <span className="absolute w-48 h-48 rounded-full border-2 border-sky-400/40 animate-radar" />
                <span
                  className="absolute w-48 h-48 rounded-full border border-cyan-400/30 animate-radar"
                  style={{ animationDelay: '0.8s' }}
                />
              </>
            )}

            <button
              type="button"
              onClick={
                phase === 'scanning' || phase === 'precheck' ? handleCancelScan : handleStartCheck
              }
              className={`relative w-44 h-44 sm:w-48 sm:h-48 rounded-full flex flex-col items-center justify-center transition-all duration-300 active:scale-95 select-none shadow-2xl border-4 ${
                phase === 'scanning' || phase === 'precheck'
                  ? 'bg-gradient-to-b from-sky-500 to-blue-600 border-sky-300/60 text-white shadow-sky-500/30'
                  : 'bg-gradient-to-b from-sky-400 via-sky-500 to-blue-600 hover:from-sky-300 hover:via-sky-400 hover:to-blue-500 border-sky-300/40 text-slate-950 shadow-sky-500/25 hover:shadow-sky-400/40'
              }`}
            >
              {phase === 'precheck' ? (
                <>
                  <RefreshCw className="w-11 h-11 animate-spin mb-2" />
                  <span className="text-sm font-extrabold uppercase tracking-wider">
                    Проверка VPN
                  </span>
                  <span className="text-[11px] opacity-85 mt-0.5">Анализ IP и ASN...</span>
                </>
              ) : phase === 'scanning' ? (
                <>
                  <div className="text-3xl font-black font-mono leading-none">
                    {progress.total > 0
                      ? `${Math.round((progress.done / progress.total) * 100)}%`
                      : '0%'}
                  </div>
                  <span className="text-xs font-bold uppercase tracking-wider mt-1.5">
                    {progress.done} из {progress.total}
                  </span>
                  <span className="text-[10px] opacity-80 mt-1 px-3 truncate max-w-[150px] font-mono">
                    {progress.currentDomain}
                  </span>
                  <span className="text-[10px] underline opacity-80 mt-1">Отменить</span>
                </>
              ) : (
                <>
                  <Radar className="w-12 h-12 mb-2 stroke-[2.2]" />
                  <span className="text-base sm:text-lg font-black uppercase tracking-wide leading-tight">
                    Проверить
                    <br />
                    сеть
                  </span>
                  <span className="text-[11px] font-semibold opacity-80 mt-1">
                    {enabledSitesCount} сайтов + VPN
                  </span>
                </>
              )}
            </button>
          </div>

          <p className="text-xs sm:text-sm text-slate-400 mt-5 max-w-md">
            Проверяет включён ли VPN, пингует {enabledSitesCount} российских и мировых ресурсов и
            определяет <strong>белые списки</strong>, <strong>глушение LTE</strong> или{' '}
            <strong>блокировки ТСПУ</strong>.
          </p>

          {/* Live Scanning Progress Bar */}
          {phase === 'scanning' && (
            <div className="w-full max-w-md mt-5">
              <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-sky-400 via-cyan-400 to-emerald-400 transition-all duration-200"
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 mt-1.5 font-mono">
                <span>
                  ОК: {liveResults.filter((r) => r.status === 'ok' || r.status === 'slow').length}
                </span>
                <span>
                  Недоступно: {liveResults.filter((r) => r.status === 'blocked').length}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ==================== БЫСТРЫЙ ВЫБОР СЕРВИСОВ ==================== */}
      {phase !== 'scanning' && (
        <div className="mt-4">
          <QuickPicks
            sites={sites}
            darkMode={darkMode}
            showToast={showToast}
            onSitesChanged={onSitesChanged}
          />
        </div>
      )}

      {/* ==================== VPN DETECTED ACTION MODAL / SHEET ==================== */}
      {(phase === 'vpn_prompt' || phase === 'waiting_vpn_off') && detectedConn && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className={`w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl border p-6 sm:p-7 shadow-2xl animate-in fade-in slide-in-from-bottom-4 ${
              darkMode
                ? 'bg-slate-900 border-amber-500/40 text-slate-100'
                : 'bg-white border-amber-300 text-slate-900'
            }`}
          >
            <div className="flex items-start gap-4 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-6 h-6 text-amber-400" />
              </div>
              <div>
                <span className="inline-block text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 mb-1">
                  Обнаружен активный туннель
                </span>
                <h3 className="text-xl font-extrabold leading-snug">
                  У вас сейчас включён VPN!
                </h3>
              </div>
            </div>

            <div
              className={`p-4 rounded-2xl border mb-4 text-xs space-y-1.5 ${
                darkMode
                  ? 'bg-slate-950/80 border-slate-800 text-slate-300'
                  : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              <div className="flex justify-between">
                <span className="text-slate-400">Внешний IP-адрес:</span>
                <span className="font-mono font-bold">{detectedConn.ip}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Локация узла:</span>
                <span className="font-semibold">
                  {detectedConn.country_name}
                  {detectedConn.city ? `, ${detectedConn.city}` : ''} ({detectedConn.country_code})
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-400 shrink-0">Провайдер / ASN:</span>
                <span className="font-semibold text-right truncate">
                  {detectedConn.isp} {detectedConn.asn ? `(${detectedConn.asn})` : ''}
                </span>
              </div>
              {detectedConn.vpn_reasons.length > 0 && (
                <div className="pt-2 mt-2 border-t border-slate-800/70 text-[11px] text-amber-400/90 space-y-1">
                  {detectedConn.vpn_reasons.map((reason, i) => (
                    <div key={i}>• {reason}</div>
                  ))}
                </div>
              )}
            </div>

            {phase === 'waiting_vpn_off' ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center gap-3">
                  <RefreshCw className="w-5 h-5 text-sky-400 animate-spin shrink-0" />
                  <div className="text-xs leading-relaxed">
                    <div className="font-bold text-sky-300 text-sm">
                      Ждём отключения VPN на телефоне...
                    </div>
                    Откройте шторку или настройки телефона и выключите VPN — приложение автоматически
                    заметит смену IP на вашего оператора и запустит проверку!
                  </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={handleConfirmTurnedOffNow}
                    className="w-full py-3.5 px-4 rounded-2xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-sm flex items-center justify-center gap-2"
                  >
                    <Play className="w-4 h-4" />
                    Я выключил — начать сейчас
                  </button>
                  <button
                    type="button"
                    onClick={handleProceedWithVpn}
                    className={`w-full py-3.5 px-4 rounded-2xl border font-semibold text-sm flex items-center justify-center gap-2 ${
                      darkMode
                        ? 'border-slate-700 hover:bg-slate-800 text-slate-200'
                        : 'border-slate-300 hover:bg-slate-100 text-slate-800'
                    }`}
                  >
                    Всё равно проверить с VPN
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-400 leading-relaxed mb-5">
                  Чтобы узнать, включены ли <strong>белые списки</strong> или глушат ли интернет у
                  вашего оператора, рекомендуется отключить VPN. Либо вы можете проверить, как
                  открываются сайты прямо через этот VPN.
                </p>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={handleWaitForVpnOff}
                    className="w-full py-3.5 px-4 rounded-2xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-sm flex items-center justify-center gap-2 shadow-lg shadow-amber-500/15 transition-all"
                  >
                    <PowerOff className="w-4 h-4" />
                    Выключить VPN и проверить сеть оператора
                  </button>

                  <button
                    type="button"
                    onClick={handleProceedWithVpn}
                    className="w-full py-3.5 px-4 rounded-2xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/35 text-sky-300 font-bold text-sm flex items-center justify-center gap-2 transition-all"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    Проверить доступ к сайтам с включённым VPN
                  </button>

                  <button
                    type="button"
                    onClick={handleCancelScan}
                    className="w-full py-2.5 text-xs font-medium text-slate-400 hover:text-slate-200"
                  >
                    Отмена
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== DIAGNOSTIC VERDICT BANNER ==================== */}
      {activeScan && phase !== 'scanning' && (
        <div className={`rounded-3xl border p-5 sm:p-7 shadow-xl transition-all ${vStyle.card}`}>
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div
                className={`w-13 h-13 p-3 rounded-2xl border shrink-0 ${
                  darkMode ? 'bg-slate-950/60 border-white/10' : 'bg-white border-black/10'
                }`}
              >
                <VerdictIcon className={`w-7 h-7 ${vStyle.iconColor}`} />
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span
                    className={`text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${vStyle.badge}`}
                  >
                    {activeScan.verdict === 'WHITELIST_ACTIVE'
                      ? 'ЕСТЬ БЕЛЫЕ СПИСКИ'
                      : activeScan.verdict === 'TOTAL_JAMMING'
                      ? 'ШАТДАУН / ГЛУШЕНИЕ'
                      : activeScan.verdict === 'SEVERE_RESTRICTIONS'
                      ? 'ЖЁСТКИЕ ОГРАНИЧЕНИЯ'
                      : activeScan.verdict === 'DPI_THROTTLING'
                      ? 'ФИЛЬТРАЦИЯ ТСПУ'
                      : 'БЕЛЫХ СПИСКОВ НЕТ'}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {new Date(activeScan.created_at).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {activeScan.vpn_detected && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                      Проверено с VPN ({activeScan.country_code})
                    </span>
                  )}
                </div>

                <h2 className="text-xl sm:text-2xl font-black tracking-tight">
                  {activeScan.verdict_title}
                </h2>
                <p
                  className={`text-sm mt-1.5 leading-relaxed max-w-3xl ${
                    darkMode ? 'text-slate-300' : 'text-slate-700'
                  }`}
                >
                  {activeScan.verdict_summary}
                </p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap sm:flex-nowrap gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopyTelegramReport}
                className={`px-3.5 py-2.5 rounded-xl text-xs font-bold border flex items-center gap-1.5 transition-all ${
                  darkMode
                    ? 'bg-slate-950/70 border-slate-700/80 hover:bg-slate-900 text-slate-200'
                    : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-800'
                }`}
              >
                {copiedReport ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4 text-sky-400" />
                )}
                {copiedReport ? 'Скопировано!' : 'Отчёт для Telegram'}
              </button>

              {(activeScan.verdict === 'WHITELIST_ACTIVE' ||
                activeScan.verdict === 'TOTAL_JAMMING' ||
                activeScan.verdict === 'SEVERE_RESTRICTIONS') && (
                <button
                  type="button"
                  onClick={() => onQuickReportIncident(activeScan)}
                  className="px-3.5 py-2.5 rounded-xl text-xs font-bold bg-rose-500 hover:bg-rose-400 text-white flex items-center gap-1.5 shadow-lg shadow-rose-500/20 transition-all"
                >
                  <Send className="w-3.5 h-3.5" />
                  Сообщить о сбое в регионе
                </button>
              )}
            </div>
          </div>

          {/* 4 Diagnostic KPI Meters */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            <div
              className={`p-3.5 rounded-2xl border ${
                darkMode ? 'bg-slate-950/60 border-white/10' : 'bg-white/80 border-slate-200'
              }`}
            >
              <div className="text-[11px] text-slate-400 font-medium">🇷🇺 Белый список РФ</div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-2xl font-black font-mono text-sky-400">
                  {activeScan.ru_ok_pct}%
                </span>
                <span className="text-[11px] text-slate-400">Перечень Минцифры</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 mt-2 overflow-hidden">
                <div
                  className="h-full bg-sky-400 rounded-full"
                  style={{ width: `${activeScan.ru_ok_pct}%` }}
                />
              </div>
            </div>

            <div
              className={`p-3.5 rounded-2xl border ${
                darkMode ? 'bg-slate-950/60 border-white/10' : 'bg-white/80 border-slate-200'
              }`}
            >
              <div className="text-[11px] text-slate-400 font-medium">
                🌐 Нейтральные (не заблокированы)
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span
                  className={`text-2xl font-black font-mono ${
                    activeScan.global_ok_pct <= 30
                      ? 'text-rose-400'
                      : activeScan.global_ok_pct < 70
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {activeScan.global_ok_pct}%
                </span>
                <span className="text-[11px] text-slate-400">Google / Wiki / GitHub</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    activeScan.global_ok_pct <= 30
                      ? 'bg-rose-500'
                      : activeScan.global_ok_pct < 70
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                  }`}
                  style={{ width: `${activeScan.global_ok_pct}%` }}
                />
              </div>
            </div>

            <div
              className={`p-3.5 rounded-2xl border ${
                darkMode ? 'bg-slate-950/60 border-white/10' : 'bg-white/80 border-slate-200'
              }`}
            >
              <div className="text-[11px] text-slate-400 font-medium">🚫 Заблокированы РКН</div>
              <div className="flex items-baseline justify-between mt-1">
                <span
                  className={`text-2xl font-black font-mono ${
                    activeScan.dpi_ok_pct < 40
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {activeScan.dpi_ok_pct}%
                </span>
                <span className="text-[11px] text-slate-400">YouTube / Discord / IG</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    activeScan.dpi_ok_pct < 40 ? 'bg-amber-400' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${activeScan.dpi_ok_pct}%` }}
                />
              </div>
            </div>

            <div
              className={`p-3.5 rounded-2xl border ${
                darkMode ? 'bg-slate-950/60 border-white/10' : 'bg-white/80 border-slate-200'
              }`}
            >
              <div className="text-[11px] text-slate-400 font-medium">⚡ Сводка доступности</div>
              <div className="flex items-baseline justify-between mt-1">
                <span className="text-2xl font-black font-mono">
                  {activeScan.ok_sites + activeScan.slow_sites}
                  <span className="text-sm text-slate-400 font-normal">
                    /{activeScan.total_sites}
                  </span>
                </span>
                <span className="text-xs font-mono text-sky-400">
                  ~{activeScan.avg_latency_ms} мс
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-2 truncate">
                {activeScan.carrier_label}
              </div>
            </div>
          </div>

          {/* Quick Note + Survival Guide Expander */}
          <div className="mt-4 pt-4 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <form onSubmit={handleSaveQuickNote} className="flex items-center gap-2 flex-1 max-w-md">
              <input
                type="text"
                value={quickNote}
                onChange={(e) => setQuickNote(e.target.value)}
                placeholder={
                  activeScan.note
                    ? `Заметка: ${activeScan.note} (изменить...)`
                    : 'Добавить пометку к замеру (напр. «МТС 4G на улице»)...'
                }
                className={`flex-1 px-3 py-1.5 rounded-xl border text-xs ${
                  darkMode
                    ? 'bg-slate-950/70 border-slate-700/80 text-white placeholder:text-slate-500'
                    : 'bg-white border-slate-300 text-slate-900'
                }`}
              />
              {quickNote.trim() && (
                <button
                  type="submit"
                  disabled={savingNote}
                  className="px-3 py-1.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs"
                >
                  Сохранить
                </button>
              )}
            </form>

            <button
              type="button"
              onClick={() => setShowTips((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-400 hover:text-sky-300"
            >
              <HelpCircle className="w-4 h-4" />
              <span>Памятка: что делать при белых списках и глушении?</span>
              {showTips ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {showTips && (
            <div
              className={`mt-3 p-4 rounded-2xl border text-xs leading-relaxed grid sm:grid-cols-3 gap-4 ${
                darkMode
                  ? 'bg-slate-950/80 border-slate-800 text-slate-300'
                  : 'bg-white border-slate-200 text-slate-700'
              }`}
            >
              <div>
                <div className="font-bold text-rose-400 mb-1">1. Если включены «Белые списки»</div>
                Прямые подключения к зарубежным IP (обычный VPN в Нидерландах/Германии) не установят
                даже TCP-соединение. Работают проводной домашний Wi-Fi (обычно шатдаун вводят только
                на мобильных сетях) либо каскадные туннели через российскую облачную ноду (Яндекс /
                VK / Selectel → Зарубеж).
              </div>
              <div>
                <div className="font-bold text-amber-400 mb-1">2. Если блокировки ТСПУ / DPI</div>
                Когда глобальные сайты работают, а не грузятся YouTube, Discord или звонки — помогает
                протокол с маскировкой TLS/UDP: <strong>VLESS + XTLS-Reality</strong>,{' '}
                <strong>AmneziaWG</strong> или <strong>Hysteria2</strong>.
              </div>
              <div>
                <div className="font-bold text-sky-400 mb-1">3. Если не открываются Госуслуги</div>
                При включённом зарубежном VPN российские банки и Госуслуги могут не пускать трафик.
                Настройте раздельное туннелирование (Routing Rules: домены <code>.ru</code> и{' '}
                <code>gosuslugi.ru</code> — напрямую).
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== 3 GROUPS: БЕЛЫЙ СПИСОК / НЕЙТРАЛЬНЫЕ / ЗАБЛОКИРОВАННЫЕ ==================== */}
      {activeScan && phase !== 'scanning' && roleGroups.ru.total + roleGroups.neutral.total > 0 && (
        <div
          className={`rounded-3xl border p-5 sm:p-6 space-y-4 ${
            darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200 shadow-sm'
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
            <div>
              <h3 className="text-base sm:text-lg font-bold">Что именно проверялось</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Три независимые группы: перечень Минцифры, нейтральные (не заблокированные)
                сайты и сервисы, заблокированные РКН. Диагноз ставится по первым двум.
              </p>
            </div>
            <span className="text-[11px] text-slate-500 shrink-0">
              Всего узлов: {displayedResults.length}
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* 1. Белый список */}
            <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-extrabold uppercase tracking-wide text-sky-300">
                  🇷🇺 Белый список РФ
                </div>
                <div className="text-sm font-black font-mono text-sky-300">
                  {roleGroups.ru.ok}/{roleGroups.ru.total}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Перечень Минцифры — должен открываться даже при отключениях мобильного интернета.
              </p>
              <div className="h-1.5 rounded-full bg-slate-800 mt-2.5 overflow-hidden">
                <div
                  className="h-full bg-sky-400 rounded-full"
                  style={{ width: `${roleGroups.ru.pct}%` }}
                />
              </div>
              <div className="mt-2.5 space-y-1 max-h-32 overflow-y-auto pr-1">
                {roleGroups.ru.items.slice(0, 12).map((r, i) => (
                  <div key={`ru-${r.domain}-${i}`} className="flex items-center gap-1.5 text-[11px]">
                    {r.status === 'blocked' ? (
                      <XCircle className="w-3 h-3 text-rose-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    )}
                    <span className="truncate text-slate-300">{r.name}</span>
                    <span className="ml-auto font-mono text-slate-500 shrink-0">
                      {r.latency_ms ? `${r.latency_ms}мс` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. Нейтральные */}
            <div
              className={`rounded-2xl border p-4 ${
                roleGroups.neutral.pct <= 40
                  ? 'border-rose-500/40 bg-rose-500/5'
                  : 'border-emerald-500/30 bg-emerald-500/5'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div
                  className={`text-xs font-extrabold uppercase tracking-wide ${
                    roleGroups.neutral.pct <= 40 ? 'text-rose-300' : 'text-emerald-300'
                  }`}
                >
                  🌐 Нейтральные (не заблокированы)
                </div>
                <div className="text-sm font-black font-mono text-slate-200">
                  {roleGroups.neutral.ok}/{roleGroups.neutral.total}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Google, Википедия, GitHub, Cloudflare, Steam — в РФ не заблокированы. Если они
                лежат, значит режут интернет целиком.
              </p>
              <div className="h-1.5 rounded-full bg-slate-800 mt-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    roleGroups.neutral.pct <= 40 ? 'bg-rose-500' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${roleGroups.neutral.pct}%` }}
                />
              </div>
              <div className="mt-2.5 space-y-1 max-h-32 overflow-y-auto pr-1">
                {roleGroups.neutral.items.slice(0, 12).map((r, i) => (
                  <div key={`n-${r.domain}-${i}`} className="flex items-center gap-1.5 text-[11px]">
                    {r.status === 'blocked' ? (
                      <XCircle className="w-3 h-3 text-rose-400 shrink-0" />
                    ) : r.status === 'slow' ? (
                      <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    )}
                    <span className="truncate text-slate-300">{r.name}</span>
                    <span className="ml-auto font-mono text-slate-500 shrink-0">
                      {r.latency_ms ? `${r.latency_ms}мс` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 3. Заблокированные РКН */}
            <div className="rounded-2xl border border-violet-500/30 bg-violet-500/5 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-extrabold uppercase tracking-wide text-violet-300">
                  🚫 Заблокированы РКН
                </div>
                <div className="text-sm font-black font-mono text-violet-300">
                  {roleGroups.blocked.ok}/{roleGroups.blocked.total}
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                YouTube, Discord, Instagram, WhatsApp… Без VPN не открываются всегда — поэтому
                их падение НЕ означает белый список.
              </p>
              <div className="flex flex-wrap gap-1 mt-2.5 max-h-32 overflow-y-auto pr-1">
                {(roleGroups.blocked.items.length > 0
                  ? roleGroups.blocked.items
                  : []
                ).slice(0, 18).map((r, i) => (
                  <span
                    key={`b-${r.domain}-${i}`}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      r.status === 'blocked'
                        ? 'border-rose-500/30 text-rose-300 bg-rose-500/10'
                        : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                    }`}
                    title={r.domain}
                  >
                    {r.name}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-slate-500 mt-2">
                Открылись через VPN: {roleGroups.blocked.ok} из {roleGroups.blocked.total}
              </div>
            </div>
          </div>

          {/* Итоговый вывод */}
          <div
            className={`rounded-2xl border p-3.5 flex flex-col sm:flex-row sm:items-center gap-3 ${
              darkMode ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="text-xs leading-relaxed text-slate-300 flex-1">
              <span className="font-extrabold text-slate-100">Вывод: </span>
              {roleGroups.ru.pct >= 45 && roleGroups.neutral.pct <= 40 && !activeScan.vpn_detected && (
                <>
                  российские сервисы открываются, а нейтральный зарубежный интернет режется —{' '}
                  <span className="text-rose-400 font-bold">это режим белых списков</span>.
                </>
              )}
              {(roleGroups.ru.pct < 45 || roleGroups.neutral.total === 0) &&
                roleGroups.neutral.pct < 30 &&
                roleGroups.ru.pct < 45 && (
                  <>
                    не открывается почти всё, включая сайты РФ —{' '}
                    <span className="text-rose-400 font-bold">
                      похоже на глушение сети / шатдаун
                    </span>
                    .
                  </>
                )}
              {roleGroups.neutral.pct >= 60 && roleGroups.blocked.pct < 70 && (
                <>
                  нейтральный интернет открыт, значит белых списков нет; недоступны только
                  сервисы из реестра РКН —{' '}
                  <span className="text-amber-400 font-bold">работает обычная фильтрация ТСПУ</span>
                  .
                </>
              )}
              {roleGroups.neutral.pct >= 65 && roleGroups.blocked.pct >= 70 && (
                <>
                  доступно всё, включая заблокированные сервисы —{' '}
                  <span className="text-emerald-400 font-bold">
                    либо VPN включён, либо сеть без ограничений
                  </span>
                  .
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onNavigateSites}
              className="shrink-0 text-[11px] font-bold px-3 py-2 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25"
            >
              Открыть каталог статусов →
            </button>
          </div>
        </div>
      )}

      {/* ==================== EXTRA PROTOCOL & PRIVACY TELEMETRY CARDS ==================== */}
      <div className="grid sm:grid-cols-3 gap-3">
        <div
          className={`p-4 rounded-2xl border flex items-start gap-3 ${
            darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200'
          }`}
        >
          <div className="p-2 rounded-xl bg-sky-500/10 text-sky-400">
            <Server className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold">Маршрут и ASN</div>
            <div className="text-xs text-slate-400 truncate mt-0.5">
              {detectedConn
                ? `${detectedConn.isp} ${detectedConn.asn ? `• ${detectedConn.asn}` : ''}`
                : 'Ожидание замера'}
            </div>
            <div className="text-[11px] text-sky-400 mt-1">
              {detectedConn?.is_hosting
                ? 'Обнаружен серверный хостинг / VPS'
                : 'Потребительская сеть оператора'}
            </div>
          </div>
        </div>

        <div
          className={`p-4 rounded-2xl border flex items-start gap-3 ${
            darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200'
          }`}
        >
          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
            <Eye className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold">Утечка WebRTC / Split-Tunnel</div>
            <div className="text-xs text-slate-400 truncate mt-0.5">
              {detectedConn?.split_tunnel
                ? 'Разные IP в HTTP и WebRTC!'
                : 'Утечек реального IP через WebRTC нет'}
            </div>
            <div className="text-[11px] text-emerald-400 mt-1">
              Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </div>
          </div>
        </div>

        <div
          className={`p-4 rounded-2xl border flex items-start gap-3 ${
            darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200'
          }`}
        >
          <div className="p-2 rounded-xl bg-violet-500/10 text-violet-400">
            <Activity className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold">Статус Cloudflare & YouTube GGC</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {(() => {
                const cf = displayedResults.find((r) => r.domain === 'cloudflare.com');
                const ggc = displayedResults.find((r) => r.domain === 'googlevideo.com');
                if (!cf && !ggc) return 'Нажмите «Проверить сеть»';
                return `CF: ${cf?.status === 'ok' ? 'ОК' : 'Блок'} • GGC: ${
                  ggc?.status === 'ok' ? 'ОК' : ggc?.status === 'slow' ? 'Замедлен' : 'Блок'
                }`;
              })()}
            </div>
            <div className="text-[11px] text-violet-400 mt-1 flex items-center gap-1">
              <Lock className="w-3 h-3" /> HTTPS / TLS проверка из браузера
            </div>
          </div>
        </div>
      </div>

      {/* ==================== CATEGORY BREAKDOWN & FULL SITES MATRIX ==================== */}
      {displayedResults.length > 0 && (
        <div
          className={`rounded-3xl border p-5 sm:p-6 ${
            darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200 shadow-sm'
          }`}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
            <div>
              <h3 className="text-base sm:text-lg font-bold">
                Детальная доступность сайтов ({displayedResults.length})
              </h3>
              <p className="text-xs text-slate-400">
                Сравнение по 6 категориям: если зелёный только «Белый список РФ», значит внешний
                интернет отрезан
              </p>
            </div>

            <button
              type="button"
              onClick={onNavigateSites}
              className="text-xs font-semibold text-sky-400 hover:text-sky-300 self-start sm:self-auto"
            >
              Настроить список сайтов →
            </button>
          </div>

          {/* Category Progress Pills */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {categoryStats.map((cat) => (
              <button
                key={cat.key}
                type="button"
                onClick={() => setSiteFilter(siteFilter === cat.key ? 'all' : cat.key)}
                className={`p-3.5 rounded-2xl border text-left transition-all ${
                  siteFilter === cat.key
                    ? 'border-sky-500 bg-sky-500/10'
                    : darkMode
                    ? 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                  <span className="truncate">{cat.meta.label}</span>
                  <span
                    className={`font-mono ${
                      cat.pct >= 75
                        ? 'text-emerald-400'
                        : cat.pct >= 35
                        ? 'text-amber-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {cat.ok}/{cat.total} ({cat.pct}%)
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      cat.pct >= 75
                        ? 'bg-emerald-400'
                        : cat.pct >= 35
                        ? 'bg-amber-400'
                        : 'bg-rose-500'
                    }`}
                    style={{ width: `${cat.pct}%` }}
                  />
                </div>
              </button>
            ))}
          </div>

          {/* Quick Status Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            <button
              type="button"
              onClick={() => setSiteFilter('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                siteFilter === 'all'
                  ? 'bg-sky-500 text-slate-950 border-sky-400'
                  : darkMode
                  ? 'bg-slate-950 border-slate-800 text-slate-400'
                  : 'bg-slate-100 border-slate-200 text-slate-600'
              }`}
            >
              Все ({displayedResults.length})
            </button>
            <button
              type="button"
              onClick={() => setSiteFilter('blocked')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                siteFilter === 'blocked'
                  ? 'bg-rose-500 text-white border-rose-400'
                  : darkMode
                  ? 'bg-slate-950 border-slate-800 text-rose-400'
                  : 'bg-rose-50 border-rose-200 text-rose-600'
              }`}
            >
              Недоступны ({displayedResults.filter((r) => r.status === 'blocked').length})
            </button>
            <button
              type="button"
              onClick={() => setSiteFilter('ok')}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                siteFilter === 'ok'
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                  : darkMode
                  ? 'bg-slate-950 border-slate-800 text-emerald-400'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-700'
              }`}
            >
              Доступны (
              {displayedResults.filter((r) => r.status === 'ok' || r.status === 'slow').length})
            </button>
          </div>

          {/* Grid of all sites */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {filteredResults.map((item, idx) => {
              const isOk = item.status === 'ok';
              const isSlow = item.status === 'slow';
              return (
                <div
                  key={`${item.domain}-${idx}`}
                  className={`px-3.5 py-2.5 rounded-xl border flex items-center justify-between gap-2 transition-all ${
                    isOk
                      ? darkMode
                        ? 'bg-slate-950/60 border-slate-800/90'
                        : 'bg-slate-50/70 border-slate-200'
                      : isSlow
                      ? darkMode
                        ? 'bg-amber-950/25 border-amber-500/30'
                        : 'bg-amber-50 border-amber-200'
                      : darkMode
                      ? 'bg-rose-950/25 border-rose-500/30'
                      : 'bg-rose-50/70 border-rose-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {isOk ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : isSlow ? (
                      <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-bold truncate">{item.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono truncate">
                        {item.domain}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    {isOk ? (
                      <span className="text-xs font-mono font-semibold text-emerald-400">
                        {item.latency_ms} мс
                      </span>
                    ) : isSlow ? (
                      <span className="text-xs font-mono font-semibold text-amber-400">
                        {item.latency_ms} мс
                      </span>
                    ) : (
                      <span className="text-[11px] font-bold text-rose-400">Блок / Таймаут</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
