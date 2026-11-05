import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  PowerOff,
  Play,
  RefreshCw,
  HelpCircle,
  Activity,
  Server,
  Eye,
  Radio,
  Gauge,
  Sparkles,
  ChevronRight,
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
  evaluateScanVerdict,
  IS_DEMO_BUILD,
  runMultiSiteScan,
} from '../lib/scanner';
import { apiFetch } from '../lib/api';
import { QuickPicks } from './QuickPicks';
import { isNativeApp } from '../lib/nativeBridge';
import { runRealSiteScan } from '../lib/realScan';
import { useSettings } from '../lib/appSettings';
import {
  connectionLabel,
  detectNetworkContext,
  toClientConnection,
  type NetworkContext,
} from '../lib/networkInfo';
import { notifyScanResult } from '../lib/notify';
import { Sheet } from './ui/Sheet';
import { Button, Chip, Notice, SectionTitle, StatusDot } from './ui/kit';

interface ScannerViewProps {
  user: User;
  sites: Site[];
  latestScan: ScanRecord | null;
  connection: ClientConnectionInfo | null;
  onConnectionDetected: (c: ClientConnectionInfo) => void;
  onScanSaved: (scan: ScanRecord) => void;
  onQuickReportIncident: (scan: ScanRecord) => void;
  onNavigateSites: () => void;
  onNavigateVpn: () => void;
  /** Есть ли у пользователя свои узлы — иначе советовать нечего */
  hasNodes?: boolean;
  onSitesChanged: () => void;
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

type Phase = 'idle' | 'precheck' | 'vpn_prompt' | 'waiting_vpn_off' | 'scanning' | 'done';

const VERDICT_META = {
  WHITELIST_ACTIVE: {
    label: 'Белые списки',
    tone: 'bad' as const,
    icon: WifiOff,
    accentRgb: 'var(--danger)',
  },
  TOTAL_JAMMING: {
    label: 'Шатдаун',
    tone: 'bad' as const,
    icon: AlertTriangle,
    accentRgb: 'var(--danger)',
  },
  SEVERE_RESTRICTIONS: {
    label: 'Жёсткие ограничения',
    tone: 'warn' as const,
    icon: ShieldAlert,
    accentRgb: 'var(--warning)',
  },
  DPI_THROTTLING: {
    label: 'Фильтрация ТСПУ',
    tone: 'warn' as const,
    icon: ShieldAlert,
    accentRgb: 'var(--warning)',
  },
  OPEN_INTERNET: {
    label: 'Интернет открыт',
    tone: 'ok' as const,
    icon: ShieldCheck,
    accentRgb: 'var(--success)',
  },
};

const toneColor = (tone: 'ok' | 'warn' | 'bad') =>
  tone === 'ok' ? 'rgb(var(--success))' : tone === 'warn' ? 'rgb(var(--warning))' : 'rgb(var(--danger))';

/** Мини-полоса прогресса. */
const Meter: React.FC<{ pct: number; color?: string; height?: number }> = ({
  pct,
  color = 'rgb(var(--accent))',
  height = 6,
}) => (
  <div
    className="w-full rounded-full overflow-hidden"
    style={{ height, background: 'var(--surface-2)' }}
  >
    <div
      className="h-full rounded-full transition-[width] duration-500 ease-out"
      style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
    />
  </div>
);

export const ScannerView: React.FC<ScannerViewProps> = ({
  user,
  sites,
  latestScan,
  connection,
  onConnectionDetected,
  onScanSaved,
  onQuickReportIncident,
  onNavigateSites,
  onNavigateVpn,
  hasNodes = false,
  onSitesChanged,
  darkMode,
  showToast,
}) => {
  const [simMode, setSimMode] = useState<SimulationMode>(IS_DEMO_BUILD ? 'sim_whitelist' : 'live');
  const [appSettings] = useSettings();
  const [netCtx, setNetCtx] = useState<NetworkContext | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [detectedConn, setDetectedConn] = useState<ClientConnectionInfo | null>(connection);
  const [progress, setProgress] = useState({ done: 0, total: 0, currentDomain: '' });
  const [liveResults, setLiveResults] = useState<ScanSiteResult[]>([]);
  // Примерные замеры из демо-набора не показываем как свои: только реальные.
  const realLatestScan = latestScan && !latestScan.demo ? latestScan : null;
  const [activeScan, setActiveScan] = useState<ScanRecord | null>(realLatestScan);

  const [siteFilter, setSiteFilter] = useState<'all' | 'blocked' | 'ok' | SiteCategory>('all');
  const [copiedReport, setCopiedReport] = useState(false);
  const [showTips, setShowTips] = useState(false);
  const [quickNote, setQuickNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [showAllSites, setShowAllSites] = useState(false);
  // Результат контрольной пробы: false — сеть мертва целиком, сайты не виноваты
  const [netControlOk, setNetControlOk] = useState(true);
  // Грубая ли оценка (в браузере нет доступа к содержимому страниц)
  const [scanApproximate, setScanApproximate] = useState(false);
  // Сеть не ответила совсем: показываем это на экране, а не только тостом
  const [networkDead, setNetworkDead] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const vpnWatchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    detectNetworkContext()
      .then((c) => alive && setNetCtx(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [appSettings.operator, appSettings.city, appSettings.networkType, appSettings.probeMode]);

  useEffect(() => {
    if (connection && phase === 'idle') setDetectedConn(connection);
  }, [connection, phase]);

  useEffect(() => {
    if (!activeScan && realLatestScan) setActiveScan(realLatestScan);
  }, [realLatestScan, activeScan]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (vpnWatchTimerRef.current) window.clearInterval(vpnWatchTimerRef.current);
    },
    []
  );

  const enabledSitesCount = sites.filter((s) => Boolean(s.enabled)).length;
  // Результат, которому больше 30 минут, помечаем как устаревший: за это время
  // сеть могла измениться, и выдавать старый вердикт за текущий нельзя.
  const staleScan = Boolean(
    activeScan && Date.now() - new Date(activeScan.created_at).getTime() > 30 * 60 * 1000
  );

  const stopVpnWatch = () => {
    if (vpnWatchTimerRef.current) {
      window.clearInterval(vpnWatchTimerRef.current);
      vpnWatchTimerRef.current = null;
    }
  };

  /* ------------------------------ запуск замера ------------------------------ */

  const handleStartCheck = async () => {
    if (enabledSitesCount === 0) {
      showToast('warning', 'Нет включённых сайтов. Добавьте сервисы или включите их в каталоге.');
      onNavigateSites();
      return;
    }
    stopVpnWatch();
    setPhase('precheck');

    let conn: ClientConnectionInfo;
    try {
      // Сеть определяем настоящую и в браузере, и в APK: подставной профиль
      // оператора раньше давал ложные подписи в отчёте.
      conn = toClientConnection(await detectNetworkContext()) as ClientConnectionInfo;
    } catch {
      conn = {
        ip: '—',
        country_code: 'RU',
        country_name: 'Россия',
        region: '',
        city: '',
        isp: '',
        org: '',
        asn: '',
        is_hosting: false,
        is_proxy: false,
        is_mobile: false,
        vpn_detected: false,
        vpn_confidence: 'none',
        vpn_reasons: [],
        webrtc_ips: [],
      };
      showToast('warning', 'Не удалось определить сеть — проверяем как есть');
    }

    setDetectedConn(conn);
    onConnectionDetected(conn);

    if (conn.vpn_detected) {
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
      setPhase('vpn_prompt');
      return;
    }

    await executeSiteScan(conn, 'direct', simMode);
  };

  const handleWaitForVpnOff = () => {
    setPhase('waiting_vpn_off');
    stopVpnWatch();

    vpnWatchTimerRef.current = window.setInterval(async () => {
      const fresh = toClientConnection(await detectNetworkContext()) as ClientConnectionInfo;
      setDetectedConn(fresh);
      onConnectionDetected(fresh);
      if (!fresh.vpn_detected) {
        stopVpnWatch();
        showToast('success', `VPN отключён (${fresh.isp || 'ваш оператор'}). Запускаем проверку.`);
        executeSiteScan(fresh, 'vpn_turned_off', 'live');
      }
    }, 2600);
  };

  const handleConfirmTurnedOffNow = async () => {
    stopVpnWatch();
    setPhase('precheck');
    const fresh = toClientConnection(await detectNetworkContext()) as ClientConnectionInfo;
    setDetectedConn(fresh);
    onConnectionDetected(fresh);
    await executeSiteScan(fresh, 'vpn_turned_off', simMode);
  };

  const handleProceedWithVpn = async () => {
    stopVpnWatch();
    if (!detectedConn) return;
    await executeSiteScan(detectedConn, 'with_vpn', simMode);
  };

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
    setShowAllSites(false);
    setProgress({ done: 0, total: enabledSitesCount, currentDomain: '' });

    const progressCb = (done: number, total: number, latest: ScanSiteResult, partial: ScanSiteResult[]) => {
      setProgress({ done, total, currentDomain: latest.domain });
      setLiveResults([...partial]);
    };

    // Достоверность важнее наглядности: настоящие запросы выполняем всегда,
    // когда это возможно. Имитация остаётся только для веб-предпросмотра,
    // где у браузера нет доступа к содержимому страниц.
    // Замеры всегда настоящие: сетевые запросы идут и в браузере, и в APK.
    // Отличается только глубина проверки — в браузере недоступно содержимое
    // страниц, поэтому результат помечается как оценочный.
    const outcome = await runRealSiteScan(sites, progressCb, ctrl.signal);
    const results: ScanSiteResult[] = outcome.results;
    const controlOk = outcome.controlOk;
    const approximate = outcome.approximate;

    if (ctrl.signal.aborted) return;
    setNetControlOk(controlOk);
    setScanApproximate(approximate);

    // Сеть мертва целиком: честно говорим об этом, а не рисуем вердикт
    // «глушение» по нулям, которые ничего не значат.
    if (!controlOk) {
      setNetworkDead(true);
      setLiveResults(results);
      setProgress({ done: results.length, total: results.length, currentDomain: '' });
      setPhase('idle');
      return;
    }
    setNetworkDead(false);

    const sitesMap = new Map<number, Site>(sites.map((site) => [site.id, site]));
    const evaluated = evaluateScanVerdict(results, vpnMode === 'with_vpn', sitesMap);

    const okCount = results.filter((r) => r.status === 'ok' || r.status === 'slow').length;
    // Уведомление нужно только тем, кто ушёл с экрана во время замера.
    if (document.visibilityState === 'hidden') {
      void notifyScanResult(
        `${evaluated.verdict_title} · ${okCount} из ${results.length} доступны`,
        `Ответы уже в приложении: ${
          appSettings.operator || netCtx?.operator || user.carrier
        }${netCtx?.city ? `, ${netCtx.city}` : ''}`
      );
    }

    const carrierLabel =
      vpnMode === 'with_vpn'
        ? `VPN • ${conn.country_name}${conn.city ? `, ${conn.city}` : ''}`
        : `${appSettings.operator || conn.isp || user.carrier} • ${appSettings.city || conn.city || user.region}`;

    const accuracyNote = !controlOk
      ? 'Сеть не ответила на контрольный запрос — вероятно, интернета нет совсем. Результаты по сайтам в этом замере недостоверны.'
      : approximate
      ? 'Оценка: в веб-версии нет доступа к содержимому страниц. Точные данные — в приложении для Android.'
      : '';

    const payload = {
      ...evaluated,
      note: accuracyNote,
      vpn_detected: conn.vpn_detected && vpnMode === 'with_vpn',
      vpn_mode: vpnMode,
      ip_address: conn.ip,
      country_code: conn.country_code,
      country_name: conn.country_name,
      city: conn.city,
      isp: conn.isp,
      asn: conn.asn,
      carrier_label: carrierLabel,
      results,
    };

    try {
      const saved = await apiFetch<{ scan: ScanRecord }>('/api/scans', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setActiveScan(saved.scan);
      setQuickNote('');
      onScanSaved(saved.scan);
    } catch {
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
        note: 'Сохранено локально (сервер недоступен)',
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

  /** Тап по кнопке во время замера: во время самого замера — отмена,
   *  во время короткой проверки VPN — ничего не делаем, чтобы не мигало. */
  const handleScanTap = () => {
    if (phase === 'precheck') return;
    handleCancelScan();
  };

  const handleCancelScan = () => {
    abortRef.current?.abort();
    stopVpnWatch();
    setPhase('idle');
    setProgress({ done: 0, total: 0, currentDomain: '' });
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

  const reportText = useMemo(() => {
    if (!activeScan) return '';
    const scanResults = activeScan.results || [];
    const interceptedCount = scanResults.filter((r) => r.intercepted).length;
    // В отчёт попадают только те отказы, где известна причина, и не больше десяти строк.
    const blockedWithReason = scanResults
      .filter((r) => r.status === 'blocked' && r.note)
      .slice(0, 10)
      .map((r) => ({ name: r.name, note: r.note as string }));
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
    return [
      `${emoji} ПульсСети — диагностика интернета`,
      `Вердикт: ${activeScan.verdict_title}`,
      `Сеть: ${activeScan.carrier_label} (${activeScan.country_code})`,
      `VPN при проверке: ${activeScan.vpn_detected ? 'включён' : 'выключен'}`,
      `Доступно: ${activeScan.ok_sites + activeScan.slow_sites} из ${activeScan.total_sites}`,
      `• Белый список РФ: ${activeScan.ru_ok_pct}%`,
      `• Нейтральные сайты: ${activeScan.global_ok_pct}%`,
      `• Заблокированы РКН: ${activeScan.dpi_ok_pct}%`,
      `Средний отклик: ${activeScan.avg_latency_ms} мс`,
      ...(interceptedCount > 0
        ? [`Подмена ответа (заглушка/чужой сертификат): ${interceptedCount} сайтов`]
        : []),
      ...(blockedWithReason.length > 0
        ? [
            'Не открылись:',
            ...blockedWithReason.map((r) => `  ${r.name} — ${r.note}`),
          ]
        : []),
      `Время: ${new Date(activeScan.created_at).toLocaleString('ru-RU')}`,
    ].join('\n');
  }, [activeScan]);

  const handleCopyReport = async () => {
    if (!reportText) return;
    try {
      await navigator.clipboard.writeText(reportText);
      setCopiedReport(true);
      showToast('success', 'Отчёт скопирован — можно вставить в Telegram');
      setTimeout(() => setCopiedReport(false), 2500);
    } catch {
      showToast('error', 'Не удалось скопировать в буфер обмена');
    }
  };

  /* --------------------------------- данные --------------------------------- */

  const displayedResults = phase === 'scanning' ? liveResults : activeScan?.results || [];

  const filteredResults = displayedResults.filter((r) => {
    if (siteFilter === 'all') return true;
    if (siteFilter === 'blocked') return r.status === 'blocked';
    if (siteFilter === 'ok') return r.status === 'ok' || r.status === 'slow';
    return r.category === siteFilter;
  });

  const roleGroups = useMemo(() => {
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
      };
    };
    return { ru: build('ru'), neutral: build('neutral'), blocked: build('blocked') };
  }, [displayedResults, sites]);

  const meta = VERDICT_META[(activeScan?.verdict as keyof typeof VERDICT_META) || 'OPEN_INTERNET'];
  const okCount = displayedResults.filter((r) => r.status === 'ok' || r.status === 'slow').length;
  const blockedCount = displayedResults.filter((r) => r.status === 'blocked').length;
  const scanning = phase === 'scanning' || phase === 'precheck';
  const progressPct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const showResult = Boolean(activeScan) && phase !== 'scanning';

  // Ничего не выдумываем: если оператор и город не определены, так и пишем.
  const connOperator = appSettings.operator || netCtx?.operator || detectedConn?.isp || '';
  const connCity = appSettings.city || netCtx?.city || detectedConn?.city || user.region || '';
  const connectionLine =
    connOperator || connCity
      ? [connOperator, connCity].filter(Boolean).join(' · ')
      : `готов проверить ${enabledSitesCount} сайтов`;
  const netKnown = Boolean(detectedConn?.ip && detectedConn.ip !== '—');

  return (
    <div className="space-y-4">
      {/* ======================= ГЛАВНАЯ КАРТОЧКА ======================= */}
      <section className="relative overflow-hidden rounded-[1.75rem] border p-4 sm:p-7"
        style={{
          borderColor: 'var(--line)',
          background:
            'radial-gradient(120% 90% at 50% -20%, rgb(var(--accent) / 0.16), transparent 60%), var(--surface)',
        }}
      >
        {/* Мягкое свечение за кнопкой */}
        <div
          className="pointer-events-none absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2 w-[24rem] h-[24rem] rounded-full"
          style={{
            /* Радиальная заливка вместо blur: дешевле для WebView и не мылит текст */
            background: `radial-gradient(circle, ${
              scanning
                ? 'rgb(var(--accent) / 0.22)'
                : showResult
                ? `color-mix(in srgb, ${meta.accentRgb} 20%, transparent)`
                : 'rgb(var(--accent) / 0.14)'
            }, transparent 68%)`,
          }}
        />

        <div className="relative flex flex-col items-center text-center">
          {showResult ? (
            /* ---------- Компактная пилюля результата ---------- */
            <button
              onClick={() => setShowAllSites(true)}
              className="inline-flex items-center gap-2 h-9 px-3.5 rounded-full border text-[12px] font-semibold tap"
              style={{
                borderColor: 'var(--line-strong)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
              }}
            >
              <StatusDot tone={meta.tone}>
                <span>{meta.label}</span>
              </StatusDot>
              <span className="text-muted">·</span>
              <span className="font-mono text-[11px]">
                {okCount}/{displayedResults.length} доступно
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-muted" />
            </button>
          ) : (
            <div
              className="inline-flex items-center gap-2 h-8 px-3 rounded-full border text-[11.5px] font-medium max-w-full"
              style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
            >
              <SignalBadge
                vpn={Boolean(detectedConn?.vpn_detected)}
                known={netKnown}
                loading={phase === 'precheck'}
              />
              <span className="truncate text-dim">{connectionLine}</span>
            </div>
          )}

          {/* ---------- Круглая кнопка-радар ---------- */}
          <div className="relative mt-4 mb-1 grid place-items-center">
            {scanning && (
              <>
                <span
                  className="radar-ring absolute w-36 h-36 sm:w-44 sm:h-44 rounded-full"
                  style={{ border: '1.5px solid rgb(var(--accent) / 0.45)' }}
                />
                <span
                  className="radar-ring absolute w-36 h-36 sm:w-44 sm:h-44 rounded-full"
                  style={{ border: '1px solid rgb(var(--accent) / 0.3)', animationDelay: '0.9s' }}
                />
              </>
            )}

            <button
              type="button"
              onClick={scanning ? handleScanTap : handleStartCheck}
              className="relative w-[8.75rem] h-[8.75rem] sm:w-44 sm:h-44 rounded-full flex flex-col items-center justify-center select-none tap-chunky"
              style={{
                background: scanning
                  ? 'linear-gradient(160deg, rgb(var(--accent)), rgb(var(--accent-2)))'
                  : showResult
                  ? `radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ${meta.accentRgb} 26%, transparent), var(--surface-solid))`
                  : 'linear-gradient(160deg, rgb(var(--accent)), rgb(var(--accent-2)))',
                color: scanning || !showResult ? 'var(--accent-contrast)' : 'var(--text)',
                border: `1px solid ${showResult && !scanning ? `color-mix(in srgb, ${meta.accentRgb} 45%, transparent)` : 'transparent'}`,
                boxShadow: scanning
                  ? '0 22px 60px -22px rgb(var(--accent) / 0.85)'
                  : showResult
                  ? `0 18px 50px -28px ${meta.accentRgb}`
                  : '0 22px 55px -20px rgb(var(--accent) / 0.7)',
                transition: 'transform .18s ease, box-shadow .25s ease, background .35s ease',
              }}
            >
              {/* Внутреннее кольцо-дуга */}
              <span
                className="pointer-events-none absolute inset-2 rounded-full"
                style={{ border: '1px solid currentColor', opacity: 0.14 }}
              />

              {phase === 'precheck' ? (
                <>
                  <RefreshCw className="w-8 h-8 animate-spin" />
                  <span className="mt-2 text-[13px] font-extrabold tracking-wide">Проверяем VPN…</span>
                </>
              ) : phase === 'scanning' ? (
                <>
                  <span className="text-[2rem] font-black font-mono leading-none tabular-nums">
                    {progressPct}%
                  </span>
                  <span className="text-[11.5px] font-bold mt-1 opacity-80 tabular-nums">
                    {progress.done} / {progress.total}
                  </span>
                  <span className="mt-1.5 text-[10px] opacity-70 max-w-[8rem] truncate font-mono">
                    {progress.currentDomain || '…'}
                  </span>
                  <span className="mt-1 text-[10px] font-bold uppercase tracking-wider opacity-80">
                    Отменить
                  </span>
                </>
              ) : showResult ? (
                <>
                  {(() => {
                    const Icon = meta.icon;
                    return <Icon className="w-9 h-9" style={{ color: meta.accentRgb }} />;
                  })()}
                  <span className="mt-2 text-[13px] font-extrabold">Повторить</span>
                  <span className="text-[10px] opacity-60 mt-0.5">замер сети</span>
                </>
              ) : (
                <>
                  <Radar className="w-9 h-9" strokeWidth={2.1} />
                  <span className="mt-2 text-[15px] font-black tracking-tight leading-tight">
                    Проверить
                    <br />
                    сеть
                  </span>
                  <span className="mt-1 text-[10.5px] font-semibold opacity-70">
                    {enabledSitesCount} сайтов
                  </span>
                </>
              )}
            </button>
          </div>

          {/* ---------- Прогресс / краткий итог ---------- */}
          {phase === 'scanning' ? (
            <div className="w-full max-w-sm mt-5 space-y-2">
              <Meter pct={progressPct} height={7} />
              <div className="flex justify-between text-[11px] text-dim font-medium">
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgb(var(--success))' }} />
                  доступно {okCount}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgb(var(--danger))' }} />
                  недоступно {blockedCount}
                </span>
              </div>
            </div>
          ) : showResult && activeScan ? (
            <div className="mt-3 w-full max-w-sm space-y-1">
              <h2 className="text-[15px] font-extrabold leading-snug">{activeScan.verdict_title}</h2>
              <p className="text-[12px] text-dim leading-snug line-clamp-2">{activeScan.verdict_summary}</p>
              <p className="text-[10.5px] text-muted pt-0.5">
                {relativeScanTime(activeScan.created_at)}
                {staleScan && (
                  <>
                    {' · '}
                    <span style={{ color: 'rgb(var(--warning))' }}>сеть могла измениться</span>
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-1">
              <h2 className="text-[17px] font-extrabold tracking-tight">Что с вашим интернетом?</h2>
              <p className="text-[12.5px] text-dim max-w-xs mx-auto leading-relaxed">
                Проверим VPN, {enabledSitesCount} сайтов и определим — белые списки, фильтрация ТСПУ
                или глушение.
              </p>
            </div>
          )}

          {/* ---------- Сеть не отвечает ---------- */}
          {networkDead && phase === 'idle' && (
            <div
              className="mt-4 rounded-2xl border p-3 text-left"
              style={{
                borderColor: 'rgb(var(--warning) / 0.4)',
                background: 'rgb(var(--warning) / 0.1)',
              }}
            >
              <div className="flex items-start gap-2">
                <WifiOff className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'rgb(var(--warning))' }} />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-bold">Интернет не отвечает</div>
                  <p className="text-[11px] text-dim leading-snug mt-1">
                    Ни один контрольный адрес не ответил. Проверьте Wi-Fi или мобильные данные —
                    пока связи нет, вердикт ставить нельзя: получилось бы «всё заблокировано» без
                    причины.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setNetworkDead(false);
                      void handleStartCheck();
                    }}
                    className="mt-2 h-8 px-3 rounded-full text-[11.5px] font-bold tap"
                    style={{ background: 'var(--surface-2)', color: 'rgb(var(--accent))' }}
                  >
                    Проверить снова
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ---------- Чипы сети ---------- */}
          <div className="mt-4 flex flex-nowrap items-center justify-center gap-1.5 px-1 whitespace-nowrap overflow-hidden">
            <Chip active className="h-7 px-2.5 text-[11px] shrink-0 gap-1">
              <Radio className="w-3 h-3 shrink-0" />
              {connectionLabel(netCtx?.kind || 'unknown')}
              {(appSettings.operator || netCtx?.operator) && (
                <span className="text-dim font-medium">
                  · {appSettings.operator || netCtx?.operator}
                </span>
              )}
            </Chip>
            {(appSettings.city || netCtx?.city || user.region) && (
              <Chip className="h-7 px-2.5 text-[11px] shrink-0">
                {appSettings.city || netCtx?.city || user.region}
              </Chip>
            )}
            {detectedConn?.ip && detectedConn.ip !== '—' && detectedConn.ip.length <= 15 && (
              <Chip className="h-7 px-2.5 shrink-0" title={detectedConn.ip}>
                <span className="font-mono text-[11px]">{detectedConn.ip}</span>
              </Chip>
            )}
          </div>
        </div>
      </section>

      {/* ======================= МОИ СЕРВИСЫ ======================= */}
      <QuickPicks
        sites={sites}
        darkMode={darkMode}
        showToast={showToast}
        onSitesChanged={onSitesChanged}
        onOpenCatalog={onNavigateSites}
        results={displayedResults}
        scanning={phase === 'scanning'}
      />

      {/* ======================= ПОЛНЫЙ ОТЧЁТ ======================= */}
      {showResult && activeScan && (
        <section className="space-y-3 anim-fade-up">
          {/* Три группы ресурсов */}
          <div className="rounded-[1.5rem] border p-4 sm:p-5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
            <SectionTitle
              hint="Диагноз ставится по первым двум группам: третья без VPN падает всегда"
              right={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  onClick={handleStartCheck}
                >
                  Ещё раз
                </Button>
              }
            >
              Что проверяли
            </SectionTitle>

            <div className="mt-3 space-y-2.5">
              <GroupRow
                title="Белый список РФ"
                hint="Перечень Минцифры — работает даже при отключениях"
                stats={roleGroups.ru}
                color="var(--accent)"
              />
              <GroupRow
                title="Нейтральные сайты"
                hint="Google, Википедия, GitHub — в РФ не заблокированы"
                stats={roleGroups.neutral}
                color={roleGroups.neutral.pct <= 40 ? 'rgb(var(--danger))' : 'rgb(var(--success))'}
              />
              <GroupRow
                title="Заблокированы РКН"
                hint="YouTube, Discord, Instagram — без VPN не открываются"
                stats={roleGroups.blocked}
                color="rgb(var(--violet))"
              />
            </div>

            <div
              className="mt-3 rounded-2xl border p-3 text-[12px] leading-relaxed"
              style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
            >
              <span className="font-bold">Вывод. </span>
              <Conclusion groups={roleGroups} withVpn={activeScan.vpn_detected} />
            </div>

            {/* Как считали: короткие цифры, чтобы вердикт можно было проверить */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted">
              <span>
                ответили {activeScan.ok_sites + activeScan.slow_sites} из {activeScan.total_sites}
              </span>
              {activeScan.slow_sites > 0 && <span>медленно {activeScan.slow_sites}</span>}
              <span>не ответили {activeScan.blocked_sites}</span>
              {displayedResults.filter((r) => r.intercepted).length > 0 && (
                <span style={{ color: 'rgb(var(--warning))' }}>
                  подмена ответа {displayedResults.filter((r) => r.intercepted).length}
                </span>
              )}
              <span>средний отклик {activeScan.avg_latency_ms} мс</span>
            </div>
          </div>

          {/* Совет: узел под найденную проблему */}
          {hasNodes && activeScan.verdict !== 'OPEN_INTERNET' && (
            <button
              type="button"
              onClick={onNavigateVpn}
              className="w-full text-left rounded-2xl border px-3 py-2.5 flex items-center gap-2.5 tap"
              style={{
                borderColor: 'rgb(var(--accent) / 0.35)',
                background: 'color-mix(in srgb, rgb(var(--accent)) 7%, var(--surface))',
              }}
            >
              <Sparkles className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--accent))' }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-bold leading-tight">
                  Подобрать узел под этот замер
                </span>
                <span className="block text-[10.5px] text-dim leading-tight mt-0.5">
                  Покажем 3 сервера из вашей подписки — без включения VPN
                </span>
              </span>
              <ChevronRight className="w-4 h-4 shrink-0 text-muted" />
            </button>
          )}

          {/* Метрики */}
          <div className="grid grid-cols-2 gap-2.5">
            <Metric
              label="Белый список РФ"
              value={`${activeScan.ru_ok_pct}%`}
              color="var(--accent)"
              pct={activeScan.ru_ok_pct}
            />
            <Metric
              label="Нейтральные сайты"
              value={`${activeScan.global_ok_pct}%`}
              color={
                activeScan.global_ok_pct <= 30
                  ? 'rgb(var(--danger))'
                  : activeScan.global_ok_pct < 70
                  ? 'rgb(var(--warning))'
                  : 'rgb(var(--success))'
              }
              pct={activeScan.global_ok_pct}
            />
            <Metric
              label="Через VPN"
              value={`${activeScan.dpi_ok_pct}%`}
              color={activeScan.dpi_ok_pct < 40 ? 'rgb(var(--warning))' : 'rgb(var(--success))'}
              pct={activeScan.dpi_ok_pct}
            />
            <Metric
              label="Средний отклик"
              value={`${activeScan.avg_latency_ms}`}
              unit="мс"
              color="rgb(var(--violet))"
              pct={Math.max(4, 100 - Math.min(100, (activeScan.avg_latency_ms / 1500) * 100))}
              hint="короче — лучше"
            />
          </div>

          {/* Маршрут / приватность */}
          <div className="grid sm:grid-cols-3 gap-2.5">
            <InfoTile
              icon={<Server className="w-4 h-4" />}
              title="Маршрут и ASN"
              value={
                detectedConn
                  ? `${detectedConn.isp || 'неизвестно'} ${detectedConn.asn ? `· ${detectedConn.asn}` : ''}`
                  : 'нет данных'
              }
              hint={
                detectedConn?.is_hosting ? 'Похоже на дата-центр (VPN)' : 'Потребительская сеть оператора'
              }
              color="var(--accent)"
            />
            <InfoTile
              icon={<Eye className="w-4 h-4" />}
              title="Утечки WebRTC"
              value={detectedConn?.split_tunnel ? 'Разные IP в HTTP и WebRTC' : 'Утечек не найдено'}
              hint={`Часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
              color="rgb(var(--success))"
            />
            <InfoTile
              icon={<Activity className="w-4 h-4" />}
              title="Cloudflare и Google Video"
              value={(() => {
                const cf = displayedResults.find((r) => r.domain.includes('cloudflare'));
                const gv = displayedResults.find((r) => r.domain.includes('googlevideo'));
                const fmt = (s?: string) => (s === 'ok' ? 'ок' : s === 'slow' ? 'медленно' : s ? 'блок' : '—');
                return `CF: ${fmt(cf?.status)} · GV: ${fmt(gv?.status)}`;
              })()}
              hint="Проверка TLS из вашей сети"
              color="rgb(var(--violet))"
            />
          </div>

          {/* Действия */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="soft"
              size="md"
              icon={copiedReport ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              onClick={handleCopyReport}
              title="Скопировать текст отчёта — вставите в любой чат"
            >
              {copiedReport ? 'Скопировано' : 'Скопировать отчёт'}
            </Button>
            {(activeScan.verdict === 'WHITELIST_ACTIVE' ||
              activeScan.verdict === 'TOTAL_JAMMING' ||
              activeScan.verdict === 'SEVERE_RESTRICTIONS') && (
              <Button
                variant="danger"
                size="md"
                icon={<Send className="w-3.5 h-3.5" />}
                onClick={() => onQuickReportIncident(activeScan)}
              >
                Сообщить о сбое
              </Button>
            )}
            <Button
              variant="ghost"
              size="md"
              icon={showTips ? <ChevronDown className="w-4 h-4 rotate-180" /> : <HelpCircle className="w-4 h-4" />}
              onClick={() => setShowTips((v) => !v)}
            >
              Что делать
            </Button>
          </div>

          {showTips && (
            <div
              className="rounded-2xl border p-4 grid sm:grid-cols-3 gap-4 text-[12px] leading-relaxed anim-fade-up"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              <div>
                <div className="font-bold mb-1" style={{ color: 'rgb(var(--danger))' }}>
                  1. Белые списки
                </div>
                Прямые подключения к зарубежным IP не установят даже TCP-соединение. Работает домашний
                Wi-Fi (шатдаун обычно только в мобильных сетях) либо каскад через российскую облачную
                ноду.
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'rgb(var(--warning))' }}>
                  2. Фильтрация ТСПУ
                </div>
                Когда глобальные сайты открываются, а YouTube или звонки — нет, помогают протоколы с
                маскировкой TLS/UDP: VLESS + Reality, AmneziaWG, Hysteria2.
              </div>
              <div>
                <div className="font-bold mb-1" style={{ color: 'rgb(var(--accent))' }}>
                  3. Госуслуги и банки
                </div>
                С зарубежным VPN российские сервисы могут не пускать трафик. Настройте раздельное
                туннелирование: домены <code className="font-mono">.ru</code> — напрямую.
              </div>
            </div>
          )}

          {/* Заметка */}
          <form onSubmit={handleSaveQuickNote} className="flex items-center gap-2">
            <input
              type="text"
              value={quickNote}
              onChange={(e) => setQuickNote(e.target.value)}
              placeholder={activeScan.note ? `Заметка: ${activeScan.note}` : 'Пометка к замеру (например, «МТС 4G на улице»)'}
              className="flex-1 h-10 px-3 rounded-xl text-[12px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--line)',
                color: 'var(--text)',
                colorScheme: darkMode ? 'dark' : 'light',
              }}
            />
            <Button type="submit" size="sm" variant="primary" loading={savingNote} disabled={!quickNote.trim()}>
              Сохранить
            </Button>
          </form>
          {activeScan.note && (
            <p className="text-[11px] text-dim mt-1.5">Сейчас: «{activeScan.note}»</p>
          )}
        </section>
      )}

      {/* ======================= ДЕТАЛЬНЫЙ СПИСОК САЙТОВ ======================= */}
      <Sheet
        open={showAllSites}
        onClose={() => setShowAllSites(false)}
        title="Доступность сайтов"
        subtitle={`${filteredResults.length} из ${displayedResults.length} · ${activeScan?.carrier_label || ''}`}
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Radar className="w-4 h-4" />
          </div>
        }
      >
        <div className="space-y-3">
          <div className="chip-rail">
            <Chip active={siteFilter === 'all'} onClick={() => setSiteFilter('all')}>
              Все {displayedResults.length}
            </Chip>
            <Chip active={siteFilter === 'ok'} onClick={() => setSiteFilter('ok')}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgb(var(--success))' }} />
              Доступны {displayedResults.filter((r) => r.status === 'ok' || r.status === 'slow').length}
            </Chip>
            <Chip active={siteFilter === 'blocked'} onClick={() => setSiteFilter('blocked')}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgb(var(--danger))' }} />
              Недоступны {displayedResults.filter((r) => r.status === 'blocked').length}
            </Chip>
            {(Object.keys(CATEGORY_META) as SiteCategory[])
              .filter((c) => displayedResults.some((r) => r.category === c))
              .map((c) => (
                <Chip key={c} active={siteFilter === c} onClick={() => setSiteFilter(c)}>
                  {CATEGORY_META[c].label}
                </Chip>
              ))}
          </div>

          <div className="space-y-1.5">
            {filteredResults.map((item, idx) => {
              const tone: 'ok' | 'warn' | 'bad' =
                item.status === 'ok' ? 'ok' : item.status === 'slow' ? 'warn' : 'bad';
              return (
                <div
                  key={`${item.domain}-${idx}`}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl border"
                  style={{
                    borderColor: 'var(--line)',
                    background:
                      tone === 'ok'
                        ? 'var(--surface-2)'
                        : `color-mix(in srgb, ${toneColor(tone)} 8%, var(--surface-2))`,
                  }}
                >
                  {tone === 'ok' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--success))' }} />
                  ) : tone === 'warn' ? (
                    <Clock className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--warning))' }} />
                  ) : (
                    <XCircle className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--danger))' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-semibold truncate">{item.name}</span>
                      {item.intercepted && (
                        <span
                          className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0"
                          style={{ background: 'rgb(var(--warning) / 0.16)', color: 'rgb(var(--warning))' }}
                        >
                          подмена
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] font-mono text-muted truncate">
                      {item.domain}
                      {item.note ? ` · ${item.note}` : ''}
                    </div>
                  </div>
                  <span
                    className="text-[11.5px] font-mono font-semibold shrink-0"
                    style={{
                      color:
                        tone === 'ok'
                          ? 'rgb(var(--success))'
                          : tone === 'warn'
                          ? 'rgb(var(--warning))'
                          : 'rgb(var(--danger))',
                    }}
                  >
                    {item.latency_ms != null ? `${item.latency_ms} мс` : 'нет ответа'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </Sheet>

      {/* ======================= VPN-ШТОРКА (через портал!) ======================= */}
      <Sheet
        open={(phase === 'vpn_prompt' || phase === 'waiting_vpn_off') && Boolean(detectedConn)}
        onClose={handleCancelScan}
        title={phase === 'waiting_vpn_off' ? 'Ждём отключения VPN' : 'У вас включён VPN'}
        subtitle={
          phase === 'waiting_vpn_off'
            ? 'Приложение заметит смену IP автоматически'
            : 'От этого зависит смысл проверки'
        }
        size="sm"
        icon={
          <div
            className="w-9 h-9 rounded-xl grid place-items-center"
            style={{
              background: 'rgb(var(--warning) / 0.14)',
              border: '1px solid rgb(var(--warning) / 0.32)',
              color: 'rgb(var(--warning))',
            }}
          >
            <ShieldAlert className="w-4 h-4" />
          </div>
        }
      >
        {detectedConn && (
          <div className="space-y-3">
            <div
              className="rounded-2xl border p-3 space-y-1.5 text-[12px]"
              style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
            >
              <RowKV k="Внешний IP" v={detectedConn.ip} mono />
              <RowKV
                k="Локация"
                v={`${detectedConn.country_name}${detectedConn.city ? `, ${detectedConn.city}` : ''} (${detectedConn.country_code})`}
              />
              <RowKV k="Провайдер" v={`${detectedConn.isp}${detectedConn.asn ? ` (${detectedConn.asn})` : ''}`} />
              {detectedConn.vpn_reasons.length > 0 && (
                <div
                  className="pt-2 mt-1 border-t space-y-1 text-[11px]"
                  style={{ borderColor: 'var(--line)', color: 'rgb(var(--warning))' }}
                >
                  {detectedConn.vpn_reasons.map((reason, i) => (
                    <div key={i}>• {reason}</div>
                  ))}
                </div>
              )}
            </div>

            {phase === 'waiting_vpn_off' ? (
              <div className="space-y-2.5">
                <Notice tone="info" icon={<RefreshCw className="w-4 h-4 animate-spin" />}>
                  Отключите VPN в шторке телефона — как только сменится IP, проверка начнётся сама.
                </Notice>
                <Button variant="primary" size="lg" block icon={<Play className="w-4 h-4" />} onClick={handleConfirmTurnedOffNow}>
                  Я выключил — начать сейчас
                </Button>
                <Button variant="outline" size="md" block onClick={handleProceedWithVpn}>
                  Всё равно проверить с VPN
                </Button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <p className="text-[12.5px] text-dim leading-relaxed">
                  Чтобы увидеть <strong style={{ color: 'var(--text)' }}>белые списки</strong> или
                  глушение у оператора, VPN нужно выключить. Либо проверим, как сайты открываются
                  через этот туннель.
                </p>
                <Button
                  variant="primary"
                  size="lg"
                  block
                  icon={<PowerOff className="w-4 h-4" />}
                  onClick={handleWaitForVpnOff}
                >
                  Выключить VPN и проверить
                </Button>
                <Button
                  variant="soft"
                  size="md"
                  block
                  icon={<ShieldCheck className="w-4 h-4" />}
                  onClick={handleProceedWithVpn}
                >
                  Проверить с включённым VPN
                </Button>
                <Button variant="ghost" size="sm" block onClick={handleCancelScan}>
                  Отмена
                </Button>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
};

/* ------------------------------- подкомпоненты ------------------------------- */

const SignalBadge: React.FC<{ vpn: boolean; known: boolean; loading: boolean }> = ({
  vpn,
  known,
  loading,
}) => {
  // Если сеть не определена — не утверждаем ни «VPN», ни «без VPN».
  const color = !known
    ? 'var(--text-muted)'
    : vpn
    ? 'rgb(var(--warning))'
    : 'rgb(var(--success))';
  const label = loading ? '…' : !known ? 'сеть?' : vpn ? 'VPN' : 'без VPN';
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color }}>
        {label}
      </span>
    </span>
  );
};

const RowKV: React.FC<{ k: string; v: string; mono?: boolean }> = ({ k, v, mono }) => (
  <div className="flex justify-between gap-3">
    <span className="text-dim shrink-0">{k}</span>
    <span className={`text-right truncate ${mono ? 'font-mono font-semibold' : 'font-semibold'}`}>{v}</span>
  </div>
);

const GroupRow: React.FC<{
  title: string;
  hint: string;
  stats: { ok: number; total: number; pct: number };
  color: string;
}> = ({ title, hint, stats, color }) => (
  <div
    className="rounded-xl border p-2.5"
    style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
  >
    <div className="flex items-baseline justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold min-w-0">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="truncate">{title}</span>
      </span>
      <span className="text-[12px] font-mono font-bold shrink-0" style={{ color }}>
        {stats.ok}/{stats.total}
      </span>
    </div>
    <div className="text-[10.5px] text-muted mt-0.5 leading-snug">{hint}</div>
    <div className="mt-2">
      <Meter pct={stats.pct} color={color} height={5} />
    </div>
  </div>
);

const Conclusion: React.FC<{
  groups: { ru: { pct: number; total: number }; neutral: { pct: number }; blocked: { pct: number; total: number } };
  withVpn: boolean;
}> = ({ groups, withVpn }) => {
  const { ru, neutral, blocked } = groups;
  if (withVpn && blocked.pct >= 70) {
    return (
      <span className="text-dim">
        через VPN открывается почти всё, включая заблокированные сервисы — туннель работает.
      </span>
    );
  }
  if (ru.pct >= 45 && neutral.pct <= 40) {
    return (
      <span className="text-dim">
        российские сервисы открываются, а нейтральный зарубежный интернет режется —{' '}
        <span className="font-bold" style={{ color: 'rgb(var(--danger))' }}>
          это режим белых списков
        </span>
        .
      </span>
    );
  }
  if (ru.pct < 45 && neutral.pct < 30) {
    return (
      <span className="text-dim">
        не открывается почти ничего, включая сайты РФ —{' '}
        <span className="font-bold" style={{ color: 'rgb(var(--danger))' }}>
          похоже на глушение сети или шатдаун
        </span>
        .
      </span>
    );
  }
  if (neutral.pct >= 60 && blocked.pct < 70) {
    return (
      <span className="text-dim">
        нейтральный интернет открыт, значит белых списков нет; недоступны только сервисы из реестра
        РКН — <span className="font-bold" style={{ color: 'rgb(var(--warning))' }}>работает фильтрация ТСПУ</span>.
      </span>
    );
  }
  return (
    <span className="text-dim">
      доступно всё, включая заблокированные сервисы —{' '}
      <span className="font-bold" style={{ color: 'rgb(var(--success))' }}>
        либо VPN включён, либо сеть без ограничений
      </span>
      .
    </span>
  );
};

/** «Только что», «12 минут назад», «вчера в 19:04» — коротко и по-русски. */
const relativeScanTime = (iso: string): string => {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'Замер только что';
  if (diffMin < 60) return `Замер ${diffMin} мин назад`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Замер ${diffH} ч назад`;
  const d = new Date(ts);
  return `Замер ${d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
};

const Metric: React.FC<{
  label: string;
  value: string;
  unit?: string;
  color: string;
  pct: number;
  hint?: string;
}> = ({ label, value, unit, color, pct, hint }) => (
  <div
    className="rounded-2xl border p-3"
    style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
  >
    <div className="text-[10px] font-semibold text-muted uppercase tracking-wide">{label}</div>
    <div className="flex items-baseline gap-1 mt-0.5">
      <span className="text-[1.35rem] font-black font-mono leading-tight tabular-nums" style={{ color }}>
        {value}
      </span>
      {unit && <span className="text-[10.5px] font-semibold text-muted">{unit}</span>}
    </div>
    <div className="mt-2">
      <Meter pct={pct} color={color} height={4} />
    </div>
    {hint && <div className="text-[10px] text-muted mt-1.5">{hint}</div>}
  </div>
);

const InfoTile: React.FC<{
  icon: React.ReactNode;
  title: string;
  value: string;
  hint: string;
  color: string;
}> = ({ icon, title, value, hint, color }) => (
  <div
    className="rounded-2xl border p-3 flex gap-2.5"
    style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
  >
    <div
      className="w-8 h-8 rounded-xl grid place-items-center shrink-0"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {icon}
    </div>
    <div className="min-w-0">
      <div className="text-[11.5px] font-bold">{title}</div>
      <div className="text-[11.5px] text-dim truncate mt-0.5">{value}</div>
      <div className="text-[10.5px] mt-0.5 truncate" style={{ color }}>
        {hint}
      </div>
    </div>
  </div>
);
