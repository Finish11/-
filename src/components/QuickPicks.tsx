import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, ExternalLink, GripVertical, Info, Loader2, Plus, Smartphone, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { getVpnDiagnostics, isNativeApp, openInstalledApp as launchInstalledApp, tcpPing, type VpnDiagnostics } from '../lib/nativeBridge';
import { apiFetch } from '../lib/api';
import { detectNetworkContext, networkSnapshotKey, toClientConnection, verifyTunnelBypass } from '../lib/networkInfo';
import { confirmationRouteStillValid, routeFingerprint, routeIdentity, suggestActiveNode, confirmationFreshness, confirmationAgeLabel } from '../lib/appConfirmations';
import { QUICK_PICKS, type QuickPick } from '../lib/quickPicks';
import { confirmationNodeKey, confirmationStatus, detectExitChange, findAppConfirmation, routeSelectionMismatch, routeTransition, type ConfirmationMatch, type RouteChange, type RouteTransition } from '../lib/appConfirmations';
import type { AppConfirmation, ClientConnectionInfo, ScanSiteResult, Site, VpnProfile } from '../types';
import { Sheet } from './ui/Sheet';
import { Button, Chip, EmptyState, Notice } from './ui/kit';

const ROUTE_MEMORY_KEY = 'pulsenet.route.memory';
function loadRememberedRoutes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(ROUTE_MEMORY_KEY) || '{}') || {}; } catch { return {}; }
}
function rememberRoute(fingerprint: string, profileId: number): void {
  if (!fingerprint) return;
  try {
    const memory = loadRememberedRoutes();
    memory[fingerprint] = profileId;
    // Не растим словарь бесконечно: старые пары вытесняются новыми.
    const entries = Object.entries(memory).slice(-60);
    localStorage.setItem(ROUTE_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* приватный режим — просто без автоопределения */ }
}

interface QuickPicksProps {
  sites: Site[];
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
  onSitesChanged: () => void;
  onOpenCatalog: () => void;
  /** Результаты последнего замера — статус и пинг прямо в карточке. */
  results?: ScanSiteResult[];
  /** Пока идёт замер — показываем «проверяем…» вместо старых цифр. */
  scanning?: boolean;
  connection: ClientConnectionInfo | null;
  profiles: VpnProfile[];
  confirmations: AppConfirmation[];
  onConfirmationSaved: (confirmation: AppConfirmation) => void;
  confirmationProfileId: number | null;
  onConfirmationRoute: (id: number | null) => Promise<void>;
}

const norm = (domain: string) => domain.replace(/^www\./, '').toLowerCase();
const DOMAIN_ALIASES: Record<string, string[]> = {
  telegram: ['web.telegram.org', 'telegram.org'],
  whatsapp: ['web.whatsapp.com', 'whatsapp.com'],
};
const quickDomains = (pick: QuickPick) => DOMAIN_ALIASES[pick.id] || [pick.domain];
const findQuickValue = <T,>(map: Map<string, T>, pick: QuickPick): T | undefined => {
  for (const domain of quickDomains(pick)) {
    const value = map.get(norm(domain));
    if (value) return value;
  }
  return undefined;
};
const ORDER_KEY = 'pulsenet_quick_order';

function loadQuickOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface Visual {
  bg: string;
  fg: string;
  label: string;
  emojiBg: string;
}

/** Логотип сервиса: буква-монограмма на узнаваемом цвете (без внешних картинок). */
const BRAND: Record<string, { letter: string; from: string; to: string; fg?: string }> = {
  chatgpt: { letter: 'AI', from: '#10a37f', to: '#0d8a6a' },
  claude: { letter: 'C', from: '#d97757', to: '#b45c3f' },
  gemini: { letter: 'G', from: '#4285f4', to: '#9b72cb' },
  telegram: { letter: 'T', from: '#2aabee', to: '#229ed9' },
  whatsapp: { letter: 'W', from: '#25d366', to: '#1da851' },
  youtube: { letter: '▶', from: '#ff0000', to: '#c40000' },
  brawlstars: { letter: 'B', from: '#f59e0b', to: '#d97706' },
};

const BrandBadge: React.FC<{ id: string; size?: number }> = ({ id, size = 34 }) => {
  const brand = BRAND[id] || { letter: '•', from: '#64748b', to: '#475569' };
  return (
    <span
      className="grid place-items-center shrink-0 font-black rounded-[0.7rem]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(145deg, ${brand.from}, ${brand.to})`,
        color: brand.fg || '#fff',
        boxShadow: `0 6px 16px -8px ${brand.from}`,
      }}
      aria-hidden="true"
    >
      {brand.letter}
    </span>
  );
};

function statusVisual(r?: ScanSiteResult, scanning?: boolean, confirmation?: ConfirmationMatch | null): Visual {
  if (scanning) {
    return { bg: 'var(--surface-2)', fg: 'var(--text-dim)', label: 'проверяем', emojiBg: 'transparent' };
  }
  if (confirmation) {
    // Единый источник правды: та же функция решает, нужен ли повторный отзыв.
    const status = confirmationStatus(confirmation);
    const color = status.tone === 'ok' ? 'success' : status.tone === 'bad' ? 'danger' : 'warning';
    return {
      bg: `rgb(var(--${color}) / ${status.tone === 'ok' ? 0.12 : 0.1})`,
      fg: `rgb(var(--${color}))`,
      label: status.label,
      emojiBg: 'transparent',
    };
  }
  if (!r) {
    return {
      bg: 'var(--surface-2)',
      fg: 'var(--text-muted)',
      label: 'не проверялся',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'provider_region_ru') {
    return {
      bg: 'rgb(var(--danger) / 0.08)',
      fg: 'rgb(var(--danger))',
      label: 'ограничено сервисом в RU',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'app_unconfirmed') {
    return {
      bg: 'rgb(var(--warning) / 0.08)',
      fg: 'rgb(var(--warning))',
      label: 'приложение не подтверждено',
      emojiBg: 'transparent',
    };
  }
  if (r.intercepted) {
    return {
      bg: 'rgb(var(--warning) / 0.1)',
      fg: 'rgb(var(--warning))',
      label: 'ответ не распознан',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'web_only') {
    return {
      bg: 'rgb(var(--warning) / 0.07)',
      fg: 'rgb(var(--warning))',
      label: r.status === 'slow' ? 'сайт медленный · приложение?' : 'страница открыта · приложение?',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'blocked') {
    return {
      bg: 'rgb(var(--danger) / 0.1)',
      fg: 'rgb(var(--danger))',
      label: 'не открыт',
      emojiBg: 'transparent',
    };
  }
  if (!r.proof || r.proof === 'endpoint' || r.proof === 'opaque') {
    return {
      bg: 'rgb(var(--warning) / 0.08)',
      fg: 'rgb(var(--warning))',
      label: !r.proof || r.proof === 'opaque'
        ? 'ответ без проверки'
        : r.status === 'slow' ? 'адрес отвечает медленно' : 'только адрес отвечает',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'slow') {
    return {
      bg: 'rgb(var(--warning) / 0.1)',
      fg: 'rgb(var(--warning))',
      label: 'страница открыта медленно',
      emojiBg: 'transparent',
    };
  }
  return {
    bg: 'rgb(var(--success) / 0.09)',
    fg: 'rgb(var(--success))',
    label: 'страница открыта',
    emojiBg: 'transparent',
  };
}

export const QuickPicks: React.FC<QuickPicksProps> = ({
  sites,
  showToast,
  onSitesChanged,
  onOpenCatalog,
  results = [],
  scanning = false,
  connection,
  profiles,
  confirmations,
  onConfirmationSaved,
  confirmationProfileId,
  onConfirmationRoute,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(loadQuickOrder);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ pick: QuickPick; result?: ScanSiteResult } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(confirmationProfileId);
  const [routeBusy, setRouteBusy] = useState(false);
  const [freshConnection, setFreshConnection] = useState<ClientConnectionInfo | null>(null);
  const [routeError, setRouteError] = useState('');
  const launchRoute = useRef<{ networkKey: string; exitIp: string; nodeKey: string; vpnPackage?: string } | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [openingApp, setOpeningApp] = useState(false);
  const [savingConfirmation, setSavingConfirmation] = useState(false);
  const [vpnDiagnostics, setVpnDiagnostics] = useState<VpnDiagnostics | null>(null);
  const [suggestion, setSuggestion] = useState('');
  const [bypassReport, setBypassReport] = useState('');
  const [bypassBusy, setBypassBusy] = useState(false);
  // Смена выходного IP при том же клиенте = человек переключил узел в клиенте.
  const [exitChange, setExitChange] = useState<RouteChange | null>(null);
  const lastRouteRef = useRef<{ ip?: string; vpnPackage?: string } | null>(null);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  /** Что произошло с маршрутом: смена узла, выключение VPN или смена сети. */
  const [transition, setTransition] = useState<RouteTransition>(null);

  const byDomain = useMemo(() => {
    const map = new Map<string, Site>();
    sites.forEach((s) => map.set(norm(s.domain), s));
    return map;
  }, [sites]);

  const resultByDomain = useMemo(() => {
    const map = new Map<string, ScanSiteResult>();
    results.forEach((r) => map.set(norm(r.domain), r));
    return map;
  }, [results]);

  const added = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index]));
    return QUICK_PICKS.map((pick) => ({ pick, site: findQuickValue(byDomain, pick) }))
      .filter((x): x is { pick: QuickPick; site: Site } => Boolean(x.site))
      .sort((a, b) => {
        const ar = rank.get(a.pick.id) ?? Number.MAX_SAFE_INTEGER;
        const br = rank.get(b.pick.id) ?? Number.MAX_SAFE_INTEGER;
        return ar - br || QUICK_PICKS.indexOf(a.pick) - QUICK_PICKS.indexOf(b.pick);
      });
  }, [byDomain, order]);

  const notAdded = useMemo(
    () => QUICK_PICKS.filter((pick) => !findQuickValue(byDomain, pick)),
    [byDomain]
  );

  /* ---------- восстановление ранее выбранных сервисов ---------- */
  useEffect(() => {
    const raw = localStorage.getItem('pulsenet_quick_ids');
    if (!raw) return;
    let ids: string[] = [];
    try {
      ids = JSON.parse(raw) as string[];
    } catch {
      return;
    }
    const present = new Set(added.map((a) => a.pick.id));
    const missing = QUICK_PICKS.filter((pick) => ids.includes(pick.id) && !present.has(pick.id));
    if (missing.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const pick of missing) {
        try {
          await apiFetch('/api/sites', {
            method: 'POST',
            body: JSON.stringify({
              name: pick.name,
              domain: pick.domain,
              probe_url: pick.probeUrl,
              category: pick.category,
              marker_role: pick.role,
              description: `${pick.hint}. Восстановлено из быстрого выбора.`,
            }),
          });
        } catch {
          // один не восстановился — не мешаем остальным
        }
      }
      if (!cancelled) onSitesChanged();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('pulsenet_quick_ids', JSON.stringify(added.map((a) => a.pick.id)));
    } catch {
      // приватный режим
    }
  }, [added.map((a) => a.pick.id).join(',')]);

  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      // приватный режим
    }
  }, [order]);

  const reorder = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    setOrder(() => {
      const ids = added.map((a) => a.pick.id);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return ids;
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      return ids;
    });
  };

  const moveBy = (id: string, delta: number) => {
    const ids = added.map((a) => a.pick.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from >= 0 && from !== to) reorder(id, ids[to]);
  };

  /* ---------- TCP-пинг игровых серверов ---------- */
  const [gamePing, setGamePing] = useState<Record<string, { ok: boolean; ms: number | null; unsupported?: boolean }>>({});
  const gameIds = added.filter((a) => a.pick.gameHost).map((a) => a.pick.id).join(',');

  useEffect(() => {
    if (!gameIds) return;
    let alive = true;
    added
      .filter((a) => a.pick.gameHost)
      .forEach(async ({ pick }) => {
        if (!isNativeApp()) {
          if (alive) {
            setGamePing((prev) => ({
              ...prev,
              [pick.id]: { ok: false, ms: null, unsupported: true },
            }));
          }
          return;
        }
        const res = await tcpPing(pick.gameHost as string, pick.gamePort || 9339);
        if (!alive) return;
        setGamePing((prev) => ({ ...prev, [pick.id]: { ok: res.ok, ms: res.latency_ms } }));
      });
    return () => {
      alive = false;
    };
  }, [gameIds]);

  /* ---------- добавление и удаление ---------- */
  const handleAdd = async (pick: QuickPick) => {
    if (busy) return;
    setBusy(pick.id);
    try {
      await apiFetch('/api/sites', {
        method: 'POST',
        body: JSON.stringify({
          name: pick.name,
          domain: pick.domain,
          probe_url: pick.probeUrl,
          category: pick.category,
          marker_role: pick.role,
          description: `${pick.hint}.${pick.caveat ? ` ${pick.caveat}` : ''}`,
        }),
      });
      showToast('success', `${pick.name} добавлен — попадёт в следующий замер`);
      onSitesChanged();
      if (notAdded.length <= 1) setExpanded(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось добавить сервис');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (pick: QuickPick, site: Site) => {
    if (busy) return;
    setBusy(pick.id);
    try {
      await apiFetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      showToast('info', `${pick.name} убран из каталога`);
      onSitesChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось убрать сервис');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => { setSelectedProfileId(confirmationProfileId); }, [confirmationProfileId]);
  const currentConnection = freshConnection || connection;
  const vpnActive = Boolean(currentConnection?.vpn_detected && currentConnection.vpn_source === 'system');
  const routeKnown = !isNativeApp() || currentConnection?.vpn_source === 'system';
  // Узел выбирает пользователь. Раньше отзыв искался только когда Android видел
  // VPN у нашего процесса: при раздельном туннеле отзыв сохранялся на узел, а
  // карточка искала «прямой маршрут» и не зеленела. Теперь выбор уважается всегда.
  const activeProfile = profiles.find((p) => p.id === confirmationProfileId) || null;
  const systemVpn = Boolean(currentConnection?.system_vpn || vpnActive);
  const splitTunnel = Boolean(currentConnection?.split_tunnel);
  const activeIp = currentConnection?.ip && currentConnection.ip !== '—' ? currentConnection.ip : '';
  const routeLabel = !routeKnown ? 'Маршрут не определён'
    : activeProfile ? `Выбран вами: ${activeProfile.name}${vpnActive ? ' · через VPN' : splitTunnel ? ' · приложение вне туннеля' : ''}`
    : vpnActive ? 'VPN включён · выберите используемый узел'
    : splitTunnel ? 'VPN включён в системе, но приложение идёт напрямую'
    : isNativeApp() ? 'Прямое подключение · системный VPN выключен' : 'Маршрут выбран вручную · браузер';
  /**
   * Android не показывает чужой конфиг, поэтому единственный честный признак
   * смены узла — новый выходной IP при том же VPN-клиенте. Раньше это молча
   * игнорировалось, и карточки продолжали показывать отзыв прошлого узла.
   */
  useEffect(() => {
    const next = { ip: activeIp, vpnPackage: currentConnection?.vpn_package };
    const previous = lastRouteRef.current;
    lastRouteRef.current = next;
    if (!activeIp) return;

    /**
     * VPN выключили в клиенте — маршрут стал прямым, и выбранный ранее узел
     * больше не описывает то, что происходит. Это не «смена узла»: человек
     * вернулся в обычный интернет, и приложение обязано вернуть прямой маршрут
     * само, а не требовать ручного выбора.
     */
    if (routeSelectionMismatch(confirmationProfileId, {
      vpnPackage: next.vpnPackage, systemVpn, nativeApp: isNativeApp(),
    })) {
      setExitChange(null);
      setRoutePickerOpen(false);
      setTransition('vpn_off');
      void onConfirmationRoute(null);
      return;
    }

    if (!previous) return;
    const event = routeTransition(previous, next);
    if (event === 'vpn_off') {
      // Трафик снова идёт напрямую: убираем узел, а не пугаем «выход сменился».
      setExitChange(null);
      setRoutePickerOpen(false);
      setTransition('vpn_off');
      if (confirmationProfileId != null) void onConfirmationRoute(null);
      return;
    }
    const change = detectExitChange(previous, next);
    if (!change) return;
    setExitChange(change);
    setTransition(event === 'node_switched' ? 'node_switched' : event);
    setRoutePickerOpen(true);
    // Память «клиент + IP» могла уже знать этот выход — предложим готовый узел.
    const suggestionForExit = suggestActiveNode(profiles, {
      vpnPackage: next.vpnPackage, exitIp: next.ip, remembered: loadRememberedRoutes(),
    });
    if (suggestionForExit && suggestionForExit.profile.id !== confirmationProfileId) {
      setSuggestion(suggestionForExit.reason);
      void onConfirmationRoute(suggestionForExit.profile.id);
    }
  }, [activeIp, currentConnection?.vpn_package, systemVpn, profiles, confirmationProfileId, onConfirmationRoute]);

  const matchFor = (pick: QuickPick, profile = activeProfile) => findAppConfirmation(confirmations, pick.id, profile, activeIp);
  /** Сколько отзывов больше не описывают текущий маршрут. */
  const needsRecheck = useMemo(() => added.filter(({ pick }) => {
    const match = matchFor(pick);
    return match ? confirmationStatus(match).recheck : false;
  }).length, [added, confirmations, activeProfile, activeIp]);
  const openDetails = async (pick: QuickPick, result?: ScanSiteResult) => {
    setSelected({ pick, result }); setSelectedProfileId(confirmationProfileId);
    setAwaitingConfirmation(false); setRouteError(''); launchRoute.current = null; setRouteBusy(true);
    setSuggestion(''); setBypassReport('');
    try {
      const ctx = await detectNetworkContext();
      if (ctx.changedDuringCheck) throw new Error('Сеть переключается. Повторите открытие карточки на стабильном маршруте.');
      const conn = toClientConnection(ctx);
      setFreshConnection(conn);
      if (isNativeApp()) {
        const diagnostics = await getVpnDiagnostics();
        setVpnDiagnostics(diagnostics);
        if (confirmationProfileId == null && (diagnostics.systemVpn || conn.vpn_detected)) {
          const suggestion = suggestActiveNode(profiles, {
            vpnPackage: diagnostics.vpnPackage || conn.vpn_package, exitIp: conn.ip, remembered: loadRememberedRoutes(),
          });
          if (suggestion) {
            setSuggestion(suggestion.reason);
            await chooseRoute(suggestion.profile.id);
          }
        }
      }
    } catch (error) {
      setFreshConnection(null); setRouteError(error instanceof Error ? error.message : 'Не удалось проверить маршрут');
    } finally { setRouteBusy(false); }
  };

  const checkBypass = async () => {
    setBypassBusy(true);
    try {
      const report = await verifyTunnelBypass();
      setBypassReport(report.reason);
      if (report.checked && report.bypassed) showToast('warning', 'Проверки идут мимо VPN — результаты нельзя приписывать туннелю');
    } finally { setBypassBusy(false); }
  };

  const selectedProfile = selectedProfileId == null
    ? null
    : profiles.find((profile) => profile.id === selectedProfileId) || null;
  const selectedMatch = selected ? matchFor(selected.pick, selectedProfile) : null;
  const canConfirm = !routeBusy && !routeError && routeKnown && Boolean(activeIp)
    && (!isNativeApp() || !systemVpn || Boolean(selectedProfile));
  const chooseRoute = async (id: number | null) => {
    const before = selectedProfileId; setSelectedProfileId(id); setRouteBusy(true);
    try { await onConfirmationRoute(id); launchRoute.current = null; setAwaitingConfirmation(false); setRouteError(''); }
    catch (error) { setSelectedProfileId(before); setRouteError(error instanceof Error ? error.message : 'Выбор узла не сохранён'); }
    finally { setRouteBusy(false); }
  };

  const handleOpenApp = async (pick: QuickPick) => {
    if (!pick.packageNames?.length) return;
    if (!isNativeApp()) {
      showToast('info', 'Запуск установленных приложений доступен в Android APK');
      return;
    }
    if (!canConfirm || !selected) { showToast('warning', 'Сначала определите маршрут и выберите включённый VPN-узел'); return; }
    setOpeningApp(true);
    try {
      const ctx = await detectNetworkContext(); const conn = toClientConnection(ctx);
      if (ctx.changedDuringCheck || !conn.ip || (isNativeApp() && (conn.vpn_detected || conn.system_vpn) && !selectedProfile))
        throw new Error('Маршрут или внешний IP не определён. Повторите проверку перед запуском.');
      if (isNativeApp() && conn.vpn_detected !== vpnActive) {
        setFreshConnection(conn); throw new Error('Системный VPN изменился. Выберите маршрут заново.');
      }
      launchRoute.current = {
        networkKey: routeIdentity(networkSnapshotKey({ connected: conn.connection_kind !== 'none', kind: conn.connection_kind || 'unknown', vpn: conn.vpn_detected, sequence: conn.native_sequence, vpnPackage: conn.vpn_package })),
        exitIp: conn.ip, nodeKey: confirmationNodeKey(selectedProfile), vpnPackage: conn.vpn_package,
      };
      setFreshConnection(conn);
      const result = await launchInstalledApp(pick.packageNames);
      if (!result.opened) {
        showToast('warning', `${pick.name} не найден среди установленных приложений`);
        return;
      }
      setAwaitingConfirmation(true);
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Не удалось открыть приложение');
    } finally {
      setOpeningApp(false);
    }
  };

  const saveConfirmation = async (works: boolean) => {
    if (!selected || !canConfirm) return;
    setSavingConfirmation(true);
    try {
      const ctx = await detectNetworkContext(); const conn = toClientConnection(ctx);
      const after = {
        networkKey: routeIdentity(networkSnapshotKey({ connected: conn.connection_kind !== 'none', kind: conn.connection_kind || 'unknown', vpn: conn.vpn_detected, sequence: conn.native_sequence, vpnPackage: conn.vpn_package })),
        exitIp: conn.ip, nodeKey: confirmationNodeKey(selectedProfile), vpnPackage: conn.vpn_package,
      };
      if (ctx.changedDuringCheck || !conn.ip || (isNativeApp() && conn.vpn_source !== 'system')
          || (isNativeApp() && (conn.vpn_detected || conn.system_vpn) && !selectedProfile)
          || (launchRoute.current && !confirmationRouteStillValid(launchRoute.current, after))) {
        setFreshConnection(conn); launchRoute.current = null; setAwaitingConfirmation(false);
        throw new Error('Сеть, VPN или IP изменились после запуска. Откройте приложение ещё раз и подтвердите текущий результат.');
      }
      setFreshConnection(conn);
      const response = await apiFetch<{ confirmation: AppConfirmation }>('/api/app-confirmations', {
        method: 'POST',
        body: JSON.stringify({
          service_id: selected.pick.id,
          domain: selected.pick.domain,
          node_key: confirmationNodeKey(selectedProfile),
          profile_id: selectedProfile?.id ?? null,
          profile_name: selectedProfile?.name || 'Прямое подключение',
          exit_ip: conn.ip,
          vpn_package: conn.vpn_package || '',
          route_source: isNativeApp() ? 'system' : 'browser-manual',
          works,
        }),
      });
      onConfirmationSaved(response.confirmation);
      if (selectedProfile) rememberRoute(routeFingerprint(conn.vpn_package, conn.ip), selectedProfile.id);
      setAwaitingConfirmation(false);
      showToast(
        works ? 'success' : 'warning',
        `${selected.pick.name}: результат сохранён для ${selectedProfile?.name || 'прямого подключения'}`
      );
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Не удалось сохранить подтверждение');
    } finally {
      setSavingConfirmation(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-1 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="text-[13px] font-bold uppercase tracking-wider text-muted">Мои сервисы</h3>
          {added.length > 0 && <span className="text-[11px] text-muted">{added.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full accent-soft text-[11.5px] font-bold tap"
        >
          <Plus className="w-3 h-3" />
          Добавить
        </button>
      </div>

      {added.length > 0 && (exitChange || needsRecheck > 0 || routePickerOpen) && (
        <div className="mb-2 rounded-2xl border p-3 space-y-2"
          style={{ borderColor: 'rgb(var(--warning) / 0.5)', background: 'rgb(var(--warning) / 0.07)' }}>
          <div className="text-[12px] font-bold" style={{ color: 'rgb(var(--warning))' }}>
            {transition === 'vpn_off' || (isNativeApp() && !systemVpn && confirmationProfileId != null)
              ? 'VPN выключен — вернули прямой маршрут'
              : exitChange
                ? exitChange.sameClient
                  ? 'Выходной IP сменился — похоже, в клиенте другой узел'
                  : transition === 'network_switched' ? 'Сменилась сеть: другой оператор или Wi-Fi' : 'Сменился маршрут: другой VPN-клиент'
                : `Отзывов, которые пора перепроверить: ${needsRecheck}`}
          </div>
          <div className="text-[11px] leading-relaxed break-anywhere" style={{ color: 'var(--text-dim)' }}>
            {transition === 'vpn_off' || (isNativeApp() && !systemVpn && confirmationProfileId != null)
              ? 'Маршрут в настройках обновлён: отзывы снова относятся к прямому подключению, а не к прошлому узлу. Отдельно выбирать «прямой» не нужно.'
              : exitChange
                ? `Было ${exitChange.fromIp}, стало ${exitChange.toIp}. Android не раскрывает конфиг чужого клиента, поэтому узел нужно отметить здесь — иначе отзывы относятся к прошлой проверке.`
                : 'Отзыв относится к другому выходу или устарел. Откройте карточку, запустите приложение и отметьте результат заново.'}
          </div>
          <label className="block text-[11px] font-semibold" style={{ color: 'var(--text-dim)' }}>
            Узел, который сейчас включён в VPN-клиенте
            <select
              value={confirmationProfileId ?? ''}
              disabled={routeBusy}
              onChange={(event) => void chooseRoute(event.target.value ? Number(event.target.value) : null)}
              className="mt-1.5 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
            >
              <option value="">{systemVpn ? 'Выберите узел — обязательное поле' : 'Не указан / прямой маршрут'}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            <span className="break-anywhere">{activeIp ? `Текущий выход ${activeIp}` : 'Выходной IP не определён'}{currentConnection?.vpn_app_name ? ` · клиент ${currentConnection.vpn_app_name}` : ''}</span>
            {confirmationProfileId != null && (
              <button type="button" disabled={routeBusy}
                onClick={() => { setExitChange(null); setRoutePickerOpen(false); setTransition(null); void onConfirmationRoute(null); }}
                className="ml-auto shrink-0 rounded-full px-2.5 h-7 font-bold tap"
                style={{ background: 'rgb(var(--accent) / 0.14)', color: 'rgb(var(--accent))' }}>
                Я напрямую — сбросить узел
              </button>
            )}
            {exitChange && (
              <button type="button" onClick={() => { setExitChange(null); setRoutePickerOpen(false); setTransition(null); }}
                className="shrink-0 rounded-full px-2.5 h-7 font-bold tap"
                style={{ background: 'var(--surface-2)', color: 'var(--text-dim)' }}>
                Узел верный, скрыть
              </button>
            )}
          </div>
        </div>
      )}

      {added.length === 0 ? (
        <div
          className="rounded-2xl border px-4 py-5 text-center"
          style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
        >
          <p className="text-[12.5px] text-dim leading-relaxed">
            Пока пусто. Добавьте сервисы, за которыми хотите следить — ChatGPT, YouTube, Telegram,
            игры и другие.
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            icon={<Sparkles className="w-3.5 h-3.5" />}
            onClick={() => setExpanded(true)}
          >
            Выбрать сервисы
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {added.map(({ pick, site }) => {
            const r = findQuickValue(resultByDomain, pick);
            const v = statusVisual(r, scanning, matchFor(pick));
            const game = gamePing[pick.id];
            return (
              <div
                key={pick.id}
                data-quick-id={pick.id}
                className="relative min-w-0 rounded-2xl border p-2.5 transition-opacity"
                style={{ borderColor: 'var(--line)', background: v.bg, opacity: draggingId === pick.id ? 0.55 : 1 }}
              >
                <div className="flex items-center justify-between gap-1">
                  <BrandBadge id={pick.id} size={30} />
                  <div className="flex items-center -mr-1">
                    <button
                      type="button"
                      className="tap-icon tap rounded-full text-muted cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                      aria-label={`Переместить ${pick.name}. Стрелки также меняют порядок`}
                      title="Перетащите карточку на новое место"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDraggingId(pick.id);
                      }}
                      onPointerMove={(e) => {
                        if (draggingId !== pick.id) return;
                        const target = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>('[data-quick-id]')
                          ?.dataset.quickId;
                        if (target) reorder(pick.id, target);
                      }}
                      onPointerUp={(e) => {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        setDraggingId(null);
                      }}
                      onPointerCancel={() => setDraggingId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          moveBy(pick.id, e.key === 'ArrowUp' ? -2 : -1);
                        }
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveBy(pick.id, e.key === 'ArrowDown' ? 2 : 1);
                        }
                      }}
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(pick, site)}
                      disabled={busy === pick.id}
                      className="tap-icon tap rounded-full text-muted hover:text-[rgb(var(--danger))]"
                      aria-label={`Убрать ${pick.name}`}
                    >
                      {busy === pick.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void openDetails(pick, r)}
                  className="mt-1.5 flex min-h-[32px] items-center gap-1 max-w-full text-left tap"
                  aria-label={`Подробнее о проверке ${pick.name}`}
                >
                  <span className="text-[12px] font-bold truncate pr-1">{pick.name}</span>
                  <Info className="w-3 h-3 shrink-0 text-muted" />
                </button>

                <div className="mt-1 flex items-start gap-1.5">
                  <span
                    className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: v.fg, opacity: scanning ? 0.5 : 1 }}
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => void openDetails(pick, r)}
                      className="block min-h-[32px] py-1 text-left text-[10.5px] leading-tight font-semibold break-words tap"
                      style={{ color: v.fg }}
                    >
                      {v.label}
                    </button>
                    {r?.latency_ms != null && (
                      <span className="block mt-0.5 text-[10px] font-mono text-muted tabular-nums">
                        {r.latency_ms} мс
                      </span>
                    )}
                  </div>
                </div>

                {pick.gameHost && !scanning && (
                  <div className="mt-1 text-[9px] font-semibold text-muted truncate">
                    {game
                      ? game.unsupported
                        ? 'игровой TCP — только в APK'
                        : game.ok
                        ? `игра TCP ${game.ms != null && game.ms < 1 ? '<1' : game.ms} мс`
                        : 'игровой TCP не проходит'
                      : 'игровой сервер…'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {added.length > 0 && (
        <p className="mt-2 text-[10px] leading-snug text-muted">
          Нажмите на карточку: можно открыть приложение и подтвердить его работу. Результат
          запоминается для выбранного VPN-узла и внешнего IP и используется в рекомендациях.
        </p>
      )}

      {/* ---------- Что именно доказала проверка ---------- */}
      <Sheet
        open={Boolean(selected)}
        onClose={() => {
          setSelected(null);
          // Снимок сети нужен только внутри карточки. Если его оставить, список
          // продолжал бы показывать старый выходной IP и не заметил смену узла.
          setFreshConnection(null);
          setRouteError('');
        }}
        title={selected?.pick.name || 'Проверка сервиса'}
        subtitle="Сайт и приложение — не одно и то же"
        size="sm"
        icon={<Info className="w-5 h-5" style={{ color: 'rgb(var(--accent))' }} />}
      >
        {selected && (
          <div className="space-y-3">
            <div
              className="rounded-2xl border p-3.5"
              style={{ borderColor: 'var(--line)', background: statusVisual(selected.result, scanning, selectedMatch).bg }}
            >
              <div className="text-[14px] font-extrabold" style={{ color: statusVisual(selected.result, scanning, selectedMatch).fg }}>
                {statusVisual(selected.result, scanning, selectedMatch).label}
              </div>
              <div className="text-[11px] font-mono text-muted mt-1">{selected.pick.domain}</div>
            </div>
            <p className="text-[12.5px] leading-relaxed text-dim">
              {selected.result?.note || selected.pick.caveat || selected.pick.hint}
            </p>
            {selected.result?.intercepted && (
              <Notice tone="warn">
                «Ответ не распознан» означает неожиданный HTML, антибот-проверку или заглушку.
                Это не доказательство взлома и не достоверный вердикт о приложении.
              </Notice>
            )}
            <div className="rounded-2xl border p-3 space-y-2.5" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
              <div className="text-[12px] font-bold">Проверить именно приложение</div>
              <div className="text-[11px] font-semibold break-words" style={{ color: 'rgb(var(--accent))' }}>
                {routeBusy ? 'Определяем свежий маршрут и IP…' : routeLabel}
                {currentConnection?.vpn_app_name ? ` · клиент ${currentConnection.vpn_app_name}` : ''}
              </div>
              {routeError && <Notice tone="warn">{routeError}</Notice>}
              {(profiles.length > 0 || !isNativeApp()) ? (
                <label className="block text-[11px] text-dim">
                  Узел, который вы сейчас используете в VPN-клиенте
                  <select
                    value={selectedProfileId ?? ''}
                    disabled={routeBusy || savingConfirmation}
                    onChange={(event) => void chooseRoute(event.target.value ? Number(event.target.value) : null)}
                    className="mt-1.5 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
                    style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
                  >
                    <option value="">{vpnActive || systemVpn ? 'Выберите узел — обязательное поле' : 'Не указан / прямой маршрут'}</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="text-[11px] text-dim">{routeKnown ? 'Системный VPN выключен; отзыв для прямого подключения.' : 'Системный маршрут не определён. Подтверждение недоступно.'}{activeIp ? ` IP ${activeIp}` : ''}</div>
              )}
              {(vpnActive || systemVpn) && <p className="text-[10.5px] leading-relaxed text-muted">Android показывает VPN-клиент, но не его внутренний конфиг.
                Сверьте имя сервера в клиенте и выберите его здесь. Выбор сохранится и в следующий раз подставится автоматически; звёздочка «основной» ничего не переключает.</p>}
              {suggestion && <Notice tone="info">Узел подставлен автоматически. {suggestion}</Notice>}
              {vpnDiagnostics?.vpnAppName && <div className="text-[11px] text-dim">VPN-клиент системы: <b>{vpnDiagnostics.vpnAppName}</b>{vpnDiagnostics.lockdown ? ' · постоянный VPN' : ''}</div>}
              {splitTunnel && (
                <Notice tone="warn">
                  VPN включён, но Android пускает трафик этого приложения мимо туннеля (раздельный туннель / per-app proxy).
                  Откройте настройки клиента и добавьте «ПульсСети» в проксируемые приложения — иначе проверки сайтов и скорости
                  показывают ваш обычный интернет, а не VPN.
                </Notice>
              )}
              {isNativeApp() && systemVpn && (
                <Button variant="outline" size="sm" block loading={bypassBusy} onClick={() => void checkBypass()}>
                  Проверить, идёт ли трафик через VPN
                </Button>
              )}
              {bypassReport && <Notice tone="info">{bypassReport}</Notice>}
              {!canConfirm && !routeBusy && !routeError && <Notice tone="warn">{!activeIp ? 'Внешний IP не определён. Откройте карточку заново после восстановления сети.' : 'Выберите используемый VPN-узел.'}</Notice>}
              {selectedMatch && (
                <Notice tone={confirmationStatus(selectedMatch).tone === 'ok' ? 'ok' : confirmationStatus(selectedMatch).tone === 'bad' ? 'bad' : 'warn'}>
                  {selectedMatch.confirmation.works ? 'Вы подтвердили: приложение работает.' : 'Вы отметили: приложение не работает.'}
                  {' '}{confirmationStatus(selectedMatch).reason}
                  {' '}{confirmationFreshness(selectedMatch.confirmation.confirmed_at) !== 'fresh' && !confirmationStatus(selectedMatch).recheck
                    ? 'Отзыв давний — ситуация могла измениться, перепроверьте. ' : ''}
                  {selectedMatch.confirmation.profile_name} · {new Date(selectedMatch.confirmation.confirmed_at).toLocaleString('ru-RU')}
                </Notice>
              )}
              {awaitingConfirmation && (
                <Notice tone="info">
                  Приложение открыто. Вернитесь после проверки входа, сообщения, видео или игры и отметьте фактический результат.
                </Notice>
              )}
              {selected.pick.packageNames && (
                <Button
                  variant="soft"
                  block
                  loading={openingApp}
                  icon={<Smartphone className="w-4 h-4" />}
                  onClick={() => void handleOpenApp(selected.pick)}
                >
                  Открыть приложение
                </Button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  disabled={savingConfirmation || !canConfirm}
                  icon={<ThumbsUp className="w-4 h-4" />}
                  onClick={() => void saveConfirmation(true)}
                >
                  Работает
                </Button>
                <Button
                  variant="outline"
                  disabled={savingConfirmation || !canConfirm}
                  icon={<ThumbsDown className="w-4 h-4" />}
                  onClick={() => void saveConfirmation(false)}
                >
                  Не работает
                </Button>
              </div>
              <p className="text-[10px] leading-snug text-muted">
                Это ваше ручное подтверждение, а не автоматический тест аккаунта. Его можно изменить после следующей проверки.
              </p>
            </div>
            <Notice tone="info">
              Сетевая проба проверяет сайт отдельно. Запуск приложения сам по себе не доказывает
              работу входа, сообщений, звонков или видео — поэтому итог подтверждаете вы.
            </Notice>
            {selected.result?.source_url && (
              <a
                href={selected.result.source_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[12px] font-bold tap"
                style={{ borderColor: 'rgb(var(--accent) / 0.35)', color: 'rgb(var(--accent))' }}
              >
                Официальный источник <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <Button variant="primary" block onClick={() => setSelected(null)}>Понятно</Button>
          </div>
        )}
      </Sheet>

      {/* ---------- Выбор сервисов ---------- */}
      <Sheet
        open={expanded}
        onClose={() => setExpanded(false)}
        title="Добавить сервис"
        subtitle="Один тап — и сервис участвует в замерах"
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Sparkles className="w-4 h-4" />
          </div>
        }
        footer={
          <>
            <Button variant="ghost" size="md" block onClick={onOpenCatalog} icon={<ChevronRight className="w-4 h-4" />}>
              Свой сайт в каталоге
            </Button>
            <Button variant="primary" size="md" block onClick={() => setExpanded(false)}>
              Готово
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {notAdded.length === 0 ? (
            <EmptyState
              icon={<Check className="w-5 h-5" />}
              title="Все сервисы добавлены"
              text="Можно убрать любой сервис, нажав на крестик на карточке."
            />
          ) : (
            notAdded.map((pick) => {
              const isBusy = busy === pick.id;
              return (
                <button
                  key={pick.id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleAdd(pick)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-2xl border text-left tap"
                  style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
                >
                  <BrandBadge id={pick.id} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold truncate">{pick.name}</div>
                    <div className="text-[11px] text-dim truncate">{pick.hint}</div>
                  </div>
                  {isBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  ) : (
                    <Plus className="w-4 h-4 shrink-0 text-muted" />
                  )}
                </button>
              );
            })
          )}

          {added.length > 0 && (
            <div className="pt-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-1.5">
                Уже добавлены
              </div>
              <div className="flex flex-wrap gap-1.5">
                {added.map(({ pick, site }) => (
                  <Chip key={pick.id} onClick={() => handleRemove(pick, site)} title={`Убрать ${pick.name}`}>
                    <BrandBadge id={pick.id} size={16} />
                    {pick.name}
                    <X className="w-3 h-3 opacity-60" />
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </Sheet>
    </section>
  );
};
