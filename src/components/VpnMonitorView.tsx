import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Info,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Plus,
  RefreshCw,
  Zap,
  Star,
  Pencil,
  Trash2,
  Loader2,
  Link2,
  QrCode,
  Download,
  FileText,
  ChevronDown,
  ChevronRight,
  Search,
  Copy,
  Check,
  AlertTriangle,
  ArrowUpDown,
  Server,
  ArrowUpRight,
  Sparkles,
  Square,
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import type { AppConfirmation, ClientConnectionInfo, ScanRecord, VpnProfile, VpnSubscription } from '../types';
import { recommendConfirmedNodes } from '../lib/appConfirmations';
import {
  detectProblem,
  looksSynthetic,
  nodeSubtitle,
  PROBLEM_TEXT,
  recommendNodes,
} from '../lib/nodeAdvisor';
import { apiFetch } from '../lib/api';
import { IS_DEMO_BUILD } from '../lib/scanner';
import { isNativeApp } from '../lib/nativeBridge';
import { applyNodeMeasurements, formatTcpLatency, measureRealDelay, nodeLatencyLabel, nodeRealDelayLabel, pingAllNodes, tcpLatencyIsComparable, type RealDelayMeasurement } from '../lib/nodePing';
import { suggestActiveNode } from '../lib/appConfirmations';
import { Sheet } from './ui/Sheet';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { ExpandableText } from './ui/ExpandableText';
import {
  Button,
  Chip,
  CountryBadge,
  EmptyState,
  Notice,
  SectionTitle,
  Skeleton,
  StatusIcon,
} from './ui/kit';

interface VpnMonitorViewProps {
  profiles: VpnProfile[];
  setProfiles: React.Dispatch<React.SetStateAction<VpnProfile[]>>;
  subscriptions: VpnSubscription[];
  setSubscriptions: React.Dispatch<React.SetStateAction<VpnSubscription[]>>;
  confirmations: AppConfirmation[];
  connection: ClientConnectionInfo | null;
  connLoading: boolean;
  onRefreshConnection: () => void;
  darkMode: boolean;
  /** Последний замер — по нему подбираем подходящие узлы */
  lastScan?: ScanRecord | null;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const PROTOCOLS = [
  { value: 'VLESS + Reality', dpi: 'high' as const, hint: 'Маскировка TLS 1.3 — лучший обход ТСПУ' },
  { value: 'VLESS', dpi: 'high' as const, hint: 'Лёгкий и быстрый, работает с XTLS' },
  { value: 'AmneziaWG', dpi: 'high' as const, hint: 'WireGuard с обфускацией пакетов' },
  { value: 'Hysteria2', dpi: 'high' as const, hint: 'QUIC/UDP, высокая скорость' },
  { value: 'VMess', dpi: 'medium' as const, hint: 'Классика v2ray, требует TLS' },
  { value: 'Trojan-gRPC', dpi: 'high' as const, hint: 'Миксуется с HTTPS-трафиком' },
  { value: 'Shadowsocks-2022', dpi: 'medium' as const, hint: 'Надёжен с плагином Cloak' },
  { value: 'TUIC v5', dpi: 'medium' as const, hint: 'Быстрый QUIC-протокол' },
  { value: 'OpenVPN', dpi: 'low' as const, hint: 'Обычно блокируется по сигнатурам' },
  { value: 'WireGuard', dpi: 'low' as const, hint: 'Чистый WG легко детектируется ТСПУ' },
  { value: 'Cloudflare WARP', dpi: 'low' as const, hint: 'Стандартные эндпоинты часто блокируются' },
];

const stripLeadingFlag = (name: string) => {
  const trimmed = name.trim();
  const stripped = trimmed
    .replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]\s*/u, '');
  return stripped.length ? stripped : trimmed;
};

const COUNTRY_BY_NAME: Array<[RegExp, string]> = [
  [/нидерланд|амстердам|голланд|nl-/i, 'NL'],
  [/финлянд|хельсинки|fi-/i, 'FI'],
  [/германи|франкфурт|берлин|de-/i, 'DE'],
  [/латви|рига|lv-/i, 'LV'],
  [/росси|москв|петербург|ru-/i, 'RU'],
  [/швеци|стокгольм|se-/i, 'SE'],
  [/польш|варшав|pl-/i, 'PL'],
  [/турци|стамбул|tr-/i, 'TR'],
  [/сша|америк|нью-йорк|us-/i, 'US'],
  [/великобритани|лондон|uk-|gb-/i, 'GB'],
  [/франци|париж|fr-/i, 'FR'],
  [/эстони|таллин|ee-/i, 'EE'],
  [/литв|вильнюс|lt-/i, 'LT'],
  [/швейцари|цюрих|ch-/i, 'CH'],
  [/япони|токио|jp-/i, 'JP'],
  [/сингапур|sg-/i, 'SG'],
  [/армян|ереван|am-/i, 'AM'],
  [/казахстан|алматы|kz-/i, 'KZ'],
  [/грузи|тбилиси|ge-/i, 'GE'],
  [/канад|ca-/i, 'CA'],
];


/** Код страны по названию узла/локации, если панель его не отдала. */
const guessCode = (...labels: Array<string | undefined>): string => {
  const hay = labels.filter(Boolean).join(' ');
  const hit = COUNTRY_BY_NAME.find(([re]) => re.test(hay));
  return hit ? hit[1] : 'XX';
};

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const statusTone = (status: VpnProfile['status']) =>
  status === 'online' ? 'ok' : status === 'degraded' ? 'warn' : status === 'unknown' ? 'idle' : 'bad';

const STATUS_LABEL: Record<VpnProfile['status'], string> = {
  online: 'TCP отвечает',
  degraded: 'TCP медленно',
  blocked: 'нет TCP',
  unknown: 'нет данных',
};

export const VpnMonitorView: React.FC<VpnMonitorViewProps> = ({
  profiles,
  setProfiles,
  subscriptions,
  setSubscriptions,
  confirmations,
  connection,
  connLoading,
  onRefreshConnection,
  lastScan = null,
  showToast,
}) => {
  // Рекомендация узлов под результат последнего замера
  const realScan = lastScan && !lastScan.demo ? lastScan : null;
  const problem = useMemo(() => (realScan ? detectProblem(realScan) : null), [realScan]);
  const recommended = useMemo(
    () => (realScan ? recommendNodes(realScan, profiles) : []),
    [realScan, profiles]
  );
  const confirmedRecommended = useMemo(
    () => recommendConfirmedNodes(profiles, confirmations).slice(0, 3),
    [profiles, confirmations]
  );
  const lastCheckedLabel = useMemo(() => {
    const times = profiles
      .map((p) => p.last_checked_at)
      .filter((t): t is string => Boolean(t))
      .sort()
      .reverse();
    if (!times.length) return '';
    const minutes = Math.floor((Date.now() - new Date(times[0]).getTime()) / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    return 'давно';
  }, [profiles]);

  const onlineTotal = profiles.filter((p) => p.status === 'online' || p.status === 'degraded').length;
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ done: number; total: number } | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  // Уход с экрана не оставляет партию проб висеть в фоне.
  useEffect(() => () => { checkAbortRef.current?.abort(); }, []);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [protoFilter, setProtoFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [sortMode, setSortMode] = useState<'ping' | 'subscription'>('ping');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ---------- узел вручную ----------
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VpnProfile | null>(null);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState('VLESS + Reality');
  const [location, setLocation] = useState('Амстердам, Нидерланды');
  const [countryCode, setCountryCode] = useState('NL');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(443);
  const [provider, setProvider] = useState('');
  const [dpiResistance, setDpiResistance] = useState<'high' | 'medium' | 'low'>('high');
  const [whitelistBypass, setWhitelistBypass] = useState(false);
  const [isPrimary, setIsPrimary] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // ---------- подписка ----------
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subTab, setSubTab] = useState<'url' | 'links'>('url');
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [subAutoUpdate, setSubAutoUpdate] = useState(true);
  const [subInterval, setSubInterval] = useState(12);
  const [subSaving, setSubSaving] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importingLinks, setImportingLinks] = useState(false);

  // ---------- QR ----------
  const [qrNode, setQrNode] = useState<VpnProfile | null>(null);
  // Подтверждение удаления: на телефоне один промах не должен сносить узлы
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'node'; node: VpnProfile } | { kind: 'sub'; sub: VpnSubscription } | null
  >(null);
  const [qrValue, setQrValue] = useState<string>('');
  const [qrLoading, setQrLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3 py-2.5 rounded-xl text-[13px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

  const openCreate = () => {
    setEditing(null);
    setName('');
    setProtocol('VLESS + Reality');
    setLocation('Амстердам, Нидерланды');
    setCountryCode('NL');
    setHost('');
    setPort(443);
    setProvider('');
    setDpiResistance('high');
    setWhitelistBypass(false);
    setIsPrimary(profiles.length === 0);
    setNotes('');
    setModalOpen(true);
  };

  const openEdit = (p: VpnProfile) => {
    setEditing(p);
    setName(p.name);
    setProtocol(p.protocol);
    setLocation(p.location);
    setCountryCode(p.country_code);
    setHost(p.host);
    setPort(p.port);
    setProvider(p.provider);
    setDpiResistance(p.dpi_resistance);
    setWhitelistBypass(Boolean(p.whitelist_bypass));
    setIsPrimary(Boolean(p.is_primary));
    setNotes(p.notes);
    setModalOpen(true);
  };

  const handleProtocolChange = (val: string) => {
    setProtocol(val);
    const found = PROTOCOLS.find((p) => p.value === val);
    if (found) setDpiResistance(found.dpi);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name,
        protocol,
        location,
        country_code: countryCode,
        host,
        port,
        provider,
        dpi_resistance: dpiResistance,
        whitelist_bypass: whitelistBypass,
        is_primary: isPrimary,
        notes,
      };
      if (editing) {
        const res = await apiFetch<{ profile: VpnProfile }>(`/api/vpn-profiles/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setProfiles((prev) =>
          prev.map((item) => {
            if (item.id === editing.id) return res.profile;
            if (res.profile.is_primary) return { ...item, is_primary: false };
            return item;
          })
        );
        showToast('success', `Узел «${res.profile.name}» обновлён`);
      } else {
        const res = await apiFetch<{ profile: VpnProfile }>('/api/vpn-profiles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setProfiles((prev) => {
          const next = res.profile.is_primary ? prev.map((x) => ({ ...x, is_primary: false })) : prev;
          return [res.profile, ...next];
        });
        showToast('success', `Узел «${res.profile.name}» добавлен`);
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения узла');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Проверка одного узла. Если сервер недоступен, в APK проверяем сами —
   * иначе кнопка «проверить» у рекомендованного узла просто ругалась бы.
   */
  const checkNodeLocally = async (p: VpnProfile): Promise<boolean> => {
    if (!isNativeApp()) return false;
    setCheckingId(p.id);
    try {
      const res = await pingAllNodes([{ host: p.host, port: Number(p.port || 443) }], () => undefined);
      const r = res[0];
      setProfiles((prev) =>
        prev.map((item) =>
          item.id === p.id
            ? {
                ...item,
                ...applyNodeMeasurements([item], [{ id: item.id, status: r.status, latencyMs: r.latencyMs,
                  reason: r.reason, checkedAt: new Date().toISOString(), route: r.route, trusted: r.trusted,
                  bypassed: r.bypassed, serverIp: r.address }])[0],
              }
            : item
        )
      );
      showToast(
        r.status === 'online' ? 'success' : r.status === 'degraded' ? 'warning' : 'error',
        `${stripLeadingFlag(p.name)}: ${
          r.latencyMs != null ? `${r.route === 'direct' && r.trusted ? 'TCP' : 'TCP без достоверного маршрута'} ${formatTcpLatency(r.latencyMs)}` : r.reason || 'нет ответа'
        }`
      );
      return true;
    } finally {
      setCheckingId(null);
    }
  };

  const handleCheckOne = async (p: VpnProfile) => {
    setCheckingId(p.id);
    try {
      const res = await apiFetch<{ profile: VpnProfile }>(`/api/vpn-profiles/${p.id}/check`, {
        method: 'POST',
      });
      setProfiles((prev) => prev.map((item) => (item.id === p.id ? res.profile : item)));
      showToast(
        res.profile.status === 'online' ? 'success' : res.profile.status === 'degraded' ? 'warning' : 'error',
        `${stripLeadingFlag(res.profile.name)}: ${
          res.profile.status === 'online'
            ? formatTcpLatency(res.profile.latency_ms)
            : res.profile.status === 'degraded'
            ? `медленно, ${formatTcpLatency(res.profile.latency_ms)}`
            : res.profile.notes || 'TCP не проходит — причина не определена'
        }`
      );
    } catch (err) {
      setCheckingId(null);
      const doneLocally = await checkNodeLocally(p);
      if (!doneLocally) {
        showToast('error', err instanceof Error ? err.message : 'Ошибка проверки узла');
      }
    } finally {
      setCheckingId(null);
    }
  };

  /** Массовый TCP в APK идёт с живым прогрессом и одним сохранением всей партии. */
  const [realDelay, setRealDelay] = useState<RealDelayMeasurement | null>(null);
  const [realDelayBusy, setRealDelayBusy] = useState(false);
  const [realDelayProfileId, setRealDelayProfileId] = useState<number | null>(null);

  /**
   * «Реальная задержка» активного подключения — как real delay в v2rayNG:
   * HTTP 204 сквозь туннель. Это единственный честный способ проверить
   * включённый конфиг, не переключая чужой VPN.
   */
  const handleRealDelay = async () => {
    setRealDelayBusy(true);
    try {
      const measurement = await measureRealDelay();
      setRealDelay(measurement);
      if (!measurement.ok) { showToast('warning', measurement.reason); return; }
      const suggested = realDelayProfileId != null
        ? profiles.find((profile) => profile.id === realDelayProfileId) || null
        : suggestActiveNode(profiles, { vpnPackage: connection?.vpn_package, exitIp: connection?.ip })?.profile || null;
      if (suggested && measurement.latencyMs != null) {
        const saved = await apiFetch<{ profile: VpnProfile }>(`/api/vpn-profiles/${suggested.id}/real-delay`, {
          method: 'POST',
          body: JSON.stringify({ latency_ms: measurement.latencyMs, route: measurement.route,
            checked_at: measurement.checkedAt, exit_ip: connection?.ip || '', vpn_package: connection?.vpn_package || '' }),
        });
        setProfiles((prev) => prev.map((profile) => profile.id === suggested.id ? { ...profile, ...saved.profile } : profile));
        showToast('success', `Реальная задержка ${formatTcpLatency(measurement.latencyMs)} · ${suggested.name}`);
      } else {
        showToast('info', `Реальная задержка ${formatTcpLatency(measurement.latencyMs)}. Выберите конфиг ниже, чтобы сохранить её для узла.`);
      }
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Не удалось измерить реальную задержку');
    } finally { setRealDelayBusy(false); }
  };

  const handleCheckAll = async (options?: { silent?: boolean; targets?: VpnProfile[] }) => {
    if (checkingAll) { checkAbortRef.current?.abort(); return; }
    const targetProfiles = options?.targets || profiles;
    const controller = new AbortController();
    checkAbortRef.current = controller;
    setCheckingAll(true);
    setCheckProgress({ done: 0, total: targetProfiles.length });
    let processed = 0;
    try {
      if (isNativeApp()) {
        const base = targetProfiles;
        const results = await pingAllNodes(
          base.map((p) => ({ host: p.host, port: Number(p.port || 443) })),
          (done, total, result, index) => {
            processed = done;
            setCheckProgress({ done, total });
            const target = base[index];
            if (!target) return;
            setProfiles((prev) => applyNodeMeasurements(prev, [{
              id: target.id,
              status: result.status,
              latencyMs: result.latencyMs,
              reason: result.reason || '',
              checkedAt: new Date().toISOString(), route: result.route, trusted: result.trusted,
              bypassed: result.bypassed, serverIp: result.address,
            }]));
          },
          { signal: controller.signal }
        );
        const checkedAt = new Date().toISOString();
        const measurements = base.map((profile, index) => ({
          id: profile.id,
          status: results[index].status,
          latencyMs: results[index].latencyMs,
          reason: results[index].reason || '', route: results[index].route, trusted: results[index].trusted,
          bypassed: results[index].bypassed, serverIp: results[index].address, checkedAt,
        }));
        setProfiles((prev) => applyNodeMeasurements(prev, measurements));
        try {
          const saved = await apiFetch<{ profiles: VpnProfile[] }>('/api/vpn-profiles/check-all', {
            method: 'POST',
            body: JSON.stringify({ measurements }),
          });
          setProfiles(saved.profiles);
        } catch {
          showToast('warning', 'TCP измерен, но сохранить результаты не удалось. Повторите проверку.');
        }
        if (!options?.silent) {
          const online = results.filter((r) => r.status === 'online' || r.status === 'degraded').length;
          showToast('success', `Проверено ${results.length} узлов с телефона, отвечают ${online}`);
        }
        return;
      }

      const res = await apiFetch<{ profiles: VpnProfile[] }>('/api/vpn-profiles/check-all', {
        method: 'POST', signal: controller.signal,
      });
      setProfiles(res.profiles);
      if (!options?.silent) {
        const online = res.profiles.filter((p) => p.status === 'online' || p.status === 'degraded').length;
        showToast('success', `Проверено ${res.profiles.length} узлов, отвечают ${online}`);
      }
    } catch (error) {
      if (!options?.silent) {
        // Остановка — не ошибка: измеренное уже показано и сохранено по узлам.
        if ((error as Error)?.name === 'AbortError' || controller.signal.aborted)
          showToast('info', `Проверка остановлена: успели проверить ${processed} из ${targetProfiles.length}`);
        else showToast('error', error instanceof Error ? error.message : 'Не удалось проверить узлы');
      }
    } finally {
      setCheckingAll(false);
      setCheckProgress(null);
      checkAbortRef.current = null;
    }
  };

  const handleSetPrimary = async (p: VpnProfile) => {
    const backup = profiles;
    setProfiles((prev) => prev.map((item) => ({ ...item, is_primary: item.id === p.id })));
    try {
      await apiFetch(`/api/vpn-profiles/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_primary: true }),
      });
      showToast('success', `«${stripLeadingFlag(p.name)}» — основной узел`);
    } catch {
      setProfiles(backup);
      showToast('error', 'Не удалось обновить основной узел');
    }
  };

  const handleDelete = async (p: VpnProfile) => {
    const backup = profiles;
    setProfiles((prev) => prev.filter((item) => item.id !== p.id));
    try {
      await apiFetch(`/api/vpn-profiles/${p.id}`, { method: 'DELETE' });
      if (p.subscription_id) {
        setSubscriptions((prev) =>
          prev.map((s) =>
            s.id === p.subscription_id ? { ...s, node_count: Math.max(0, s.node_count - 1) } : s
          )
        );
      }
      showToast('info', `Узел «${stripLeadingFlag(p.name)}» удалён`);
    } catch {
      setProfiles(backup);
      showToast('error', 'Ошибка удаления узла');
    }
  };

  const openSubModal = () => {
    setSubUrl('');
    setSubName('');
    setSubAutoUpdate(true);
    setSubInterval(12);
    setImportText('');
    setSubTab('url');
    setSubError(null);
    setSubModalOpen(true);
  };

  const handleAddSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subUrl.trim()) {
      showToast('warning', 'Вставьте ссылку подписки');
      return;
    }
    // Строка без схемы раньше проваливалась мимо настоящего импорта в
    // демо-ветку: «не ссылка» превращалась в 8 узлов «Демо-подписки», и в APK
    // это выглядело как успешно загруженная подписка. Проверяем до запроса.
    if (!/^https?:\/\//i.test(subUrl.trim())) {
      const message = 'Ссылка должна начинаться с http:// или https:// — скопируйте её из панели провайдера целиком.';
      setSubError(message);
      showToast('warning', message);
      return;
    }
    setSubSaving(true);
    setSubError(null);
    try {
      const res = await apiFetch<{
        subscription: VpnSubscription;
        profiles: VpnProfile[];
        imported: number;
        online: number;
      }>('/api/vpn-subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          url: subUrl.trim(),
          name: subName.trim() || undefined,
          auto_update: subAutoUpdate,
          update_interval_hours: subInterval,
        }),
      });
      setSubscriptions((prev) => [res.subscription, ...prev]);
      setProfiles(res.profiles);
      showToast('success', `Подписка загружена: ${res.imported} узлов`);
      setSubModalOpen(false);
      // Сразу проверяем узлы — иначе список выглядит «мёртвым» с нулями.
      if (res.imported > 0) void handleCheckAll({ silent: true, targets: res.profiles });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось загрузить подписку';
      setSubError(message);
      showToast('error', 'Подписка не загрузилась — подробности в окне');
    } finally {
      setSubSaving(false);
    }
  };

  const handleImportLinks = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importText.trim()) return;
    setImportingLinks(true);
    setSubError(null);
    try {
      const res = await apiFetch<{
        imported: number;
        profiles: VpnProfile[];
        source_candidates?: number;
        duplicates_removed?: number;
        unrecognized?: number;
      }>(
        '/api/vpn-profiles/import',
        {
          method: 'POST',
          body: JSON.stringify({ text: importText.trim(), group_name: 'Импорт вручную' }),
        }
      );
      setProfiles(res.profiles);
      const importNotes = [
        res.duplicates_removed ? `копий удалено: ${res.duplicates_removed}` : '',
        res.unrecognized ? `не распознано: ${res.unrecognized}` : '',
      ].filter(Boolean);
      showToast(
        res.unrecognized ? 'warning' : 'success',
        `Импортировано узлов: ${res.imported}${importNotes.length ? ` · ${importNotes.join(' · ')}` : ''}`
      );
      if (res.imported > 0) setSubModalOpen(false);
      else setSubError('В тексте не нашлось ни одной ссылки на узел. Поддерживаются vless://, vmess://, trojan://, ss://, hysteria2://, tuic://, wg://');
    } catch (err) {
      setSubError(err instanceof Error ? err.message : 'Не удалось распознать ссылки');
    } finally {
      setImportingLinks(false);
    }
  };

  const handleSyncSubscription = async (s: VpnSubscription) => {
    setSyncingId(s.id);
    try {
      const res = await apiFetch<{
        subscription: VpnSubscription;
        profiles: VpnProfile[];
        imported: number;
      }>(`/api/vpn-subscriptions/${s.id}/sync`, { method: 'POST' });
      setSubscriptions((prev) => prev.map((item) => (item.id === s.id ? res.subscription : item)));
      setProfiles(res.profiles);
      showToast('success', `«${s.name}»: обновлено ${res.imported} узлов`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка синхронизации';
      setSubscriptions((prev) =>
        prev.map((item) =>
          item.id === s.id ? { ...item, last_sync_status: 'error', last_sync_message: message } : item
        )
      );
      showToast('error', message);
    } finally {
      setSyncingId(null);
    }
  };

  const handleDeleteSubscription = async (s: VpnSubscription) => {
    const backupProfiles = profiles;
    const backupSubs = subscriptions;
    setSubscriptions((prev) => prev.filter((item) => item.id !== s.id));
    setProfiles((prev) => prev.filter((p) => p.subscription_id !== s.id));
    try {
      await apiFetch(`/api/vpn-subscriptions/${s.id}`, { method: 'DELETE' });
      showToast('info', `Подписка «${s.name}» и её узлы удалены`);
    } catch {
      setProfiles(backupProfiles);
      setSubscriptions(backupSubs);
      showToast('error', 'Не удалось удалить подписку');
    }
  };

  const handleOpenQr = async (p: VpnProfile) => {
    setQrNode(p);
    setQrLoading(true);
    setQrValue(p.raw_link || '');
    try {
      const res = await apiFetch<{ qr: string; target: string }>(`/api/vpn-profiles/${p.id}/qr`);
      setQrValue(res.target);
    } catch {
      // остаётся raw_link
    } finally {
      setQrLoading(false);
    }
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      showToast('error', 'Не удалось скопировать');
    }
  };

  const filteredProfiles = useMemo(() => {
    const filtered = profiles.filter((p) => {
      if (protoFilter !== 'all' && p.dpi_resistance !== protoFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.location.toLowerCase().includes(q) ||
        p.protocol.toLowerCase().includes(q) ||
        (p.group_name || '').toLowerCase().includes(q)
      );
    });
    if (sortMode === 'ping') {
      // Сначала реально отвечающие и самые быстрые; неизвестные и блок — внизу.
      filtered.sort((a, b) => {
        const am = tcpLatencyIsComparable(a) && a.status !== 'blocked' ? a.latency_ms! : Number.POSITIVE_INFINITY;
        const bm = tcpLatencyIsComparable(b) && b.status !== 'blocked' ? b.latency_ms! : Number.POSITIVE_INFINITY;
        return am - bm || a.name.localeCompare(b.name, 'ru');
      });
    }
    return filtered;
  }, [profiles, search, protoFilter, sortMode]);

  const grouped = useMemo(() => {
    const map = new Map<string, VpnProfile[]>();
    for (const p of filteredProfiles) {
      const key = p.subscription_id
        ? subscriptions.find((s) => s.id === p.subscription_id)?.name || p.group_name || 'Подписка'
        : 'Мои узлы';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries());
  }, [filteredProfiles, subscriptions]);

  const stats = useMemo(() => {
    const total = profiles.length;
    const online = profiles.filter((p) => p.status === 'online').length;
    const degraded = profiles.filter((p) => p.status === 'degraded').length;
    const blocked = profiles.filter((p) => p.status === 'blocked').length;
    const latencies = profiles.filter(tcpLatencyIsComparable)
      .map((p) => p.latency_ms)
      .filter((v): v is number => typeof v === 'number');
    return {
      total,
      online,
      degraded,
      blocked,
      avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    };
  }, [profiles]);

  const vpnOn = Boolean(connection?.vpn_detected && connection.vpn_source === 'system');
  const vpnKnown = connection?.vpn_source === 'system';

  return (
    <div className="space-y-4">
      {/* ---------- Заголовок ---------- */}
      <header className="space-y-2">
        <h1 className="text-[22px] font-black tracking-tight">VPN-узлы</h1>
        <p className="text-[12.5px] text-dim leading-snug">
          Подписки и узлы: проверяем доступность каждого сервера и показываем статус. Туннеля внутри
          приложения нет — подключение выполняет ваш VPN-клиент.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="primary"
            size="md"
            icon={<Link2 className="w-4 h-4" />}
            onClick={openSubModal}
          >
            Добавить подписку
          </Button>
          <Button variant="outline" size="md" icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            Узел вручную
          </Button>
        </div>
      </header>

      {/* ---------- Текущее соединение ---------- */}
      <section
        className="rounded-[1.5rem] border p-4"
        style={{
          borderColor: vpnOn ? 'rgb(var(--warning) / 0.35)' : 'var(--line)',
          background: vpnOn
            ? 'color-mix(in srgb, rgb(var(--warning)) 8%, var(--surface))'
            : 'var(--surface)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-2xl grid place-items-center shrink-0"
            style={{
              background: vpnOn ? 'rgb(var(--warning) / 0.14)' : vpnKnown ? 'rgb(var(--success) / 0.12)' : 'var(--surface-2)',
              color: vpnOn ? 'rgb(var(--warning))' : vpnKnown ? 'rgb(var(--success))' : 'var(--text-dim)',
            }}
          >
            {vpnOn || !vpnKnown ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted">
                сейчас
              </span>
              <span
                className="text-[10.5px] font-bold px-2 py-0.5 rounded-full"
                style={{
                  background: vpnOn ? 'rgb(var(--warning) / 0.16)' : vpnKnown ? 'rgb(var(--success) / 0.14)' : 'var(--surface-2)',
                  color: vpnOn ? 'rgb(var(--warning))' : vpnKnown ? 'rgb(var(--success))' : 'var(--text-dim)',
                }}
              >
                {vpnOn ? 'VPN включён' : vpnKnown ? 'прямое подключение' : 'системный статус неизвестен'}
              </span>
            </div>
            <div className="text-[14px] font-bold mt-1 leading-snug break-words">
              {connection
                ? `${[connection.country_name, connection.city].filter(Boolean).join(', ') || 'Маршрут определяется'} — ${
                    connection.operator || connection.isp || 'провайдер неизвестен'
                  }`
                : 'определяем маршрут…'}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted font-mono mt-1">
              <span>IP {connection?.ip || '…'}</span>
              {connection?.asn && <span>{connection.asn}</span>}
              <span>
                {connection?.connection_kind === 'wifi'
                  ? 'Wi-Fi'
                  : connection?.connection_kind === 'cellular'
                  ? 'мобильная сеть'
                  : connection?.connection_kind === 'ethernet'
                  ? 'Ethernet'
                  : connection?.connection_kind === 'none'
                  ? 'нет сети'
                  : connection?.is_hosting
                  ? 'дата-центр'
                  : connection?.is_mobile
                  ? 'мобильная сеть'
                  : 'тип сети не определён'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefreshConnection}
            disabled={connLoading}
            className="shrink-0 p-2 rounded-xl border text-dim tap"
            style={{ borderColor: 'var(--line)' }}
            aria-label="Перепроверить соединение"
          >
            <RefreshCw className={`w-4 h-4 ${connLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </section>

      {/* ---------- Узлы, проверенные пользователем в приложениях ---------- */}
      {profiles.length > 0 && (
        <section className="rounded-[1.5rem] border p-3.5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <div className="flex items-start gap-2.5">
            <Sparkles className="w-4.5 h-4.5 shrink-0 mt-0.5" style={{ color: 'rgb(var(--accent))' }} />
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-bold">Лучшие для ваших приложений</h2>
              <p className="text-[10.5px] text-dim mt-0.5 leading-snug">
                Рейтинг по вашим ручным отзывам. TCP участвует в сравнении только с подтверждённого прямого маршрута.
                Основной узел — только отметка для VPN-клиента, не включение туннеля.
              </p>
            </div>
          </div>
          {confirmedRecommended.length === 0 ? (
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
              Пока нет ручных результатов. На главной откройте карточку сервиса, запустите приложение
              и подтвердите результат для текущего узла — рекомендации появятся здесь.
            </p>
          ) : (
            <div className="mt-2.5 space-y-1.5">
              {confirmedRecommended.map(({ profile, works, failures }) => (
                <div key={profile.id} className="flex items-center gap-2 rounded-xl px-2.5 py-2" style={{ background: 'var(--surface-2)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-bold truncate">{profile.name}</div>
                    <div className="text-[10px] text-dim">
                      работает: {works}{failures ? ` · не работает: ${failures}` : ''}
                       · {nodeLatencyLabel(profile)}
                    </div>
                  </div>
                  {profile.is_primary ? (
                    <span className="text-[10px] font-bold" style={{ color: 'rgb(var(--success))' }}>основной</span>
                  ) : (
                    <Button size="sm" variant="soft" onClick={() => void handleSetPrimary(profile)}>
                      Сделать основным
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- Статистика ---------- */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'всего', value: stats.total, color: 'var(--text)' },
            { label: 'онлайн', value: stats.online, color: 'rgb(var(--success))' },
            { label: 'медленно', value: stats.degraded, color: 'rgb(var(--warning))' },
            { label: 'блок', value: stats.blocked, color: 'rgb(var(--danger))' },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-2xl border px-2 py-2.5 text-center"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              <div className="text-[1.05rem] font-black font-mono leading-none" style={{ color: s.color }}>
                {s.value}
              </div>
              <div className="text-[9.5px] uppercase tracking-wide text-muted mt-1 font-bold">
                {s.label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Подписки ---------- */}
      {subscriptions.length > 0 && (
        <section className="space-y-2">
          <SectionTitle right={<span className="text-[11px] text-muted">{subscriptions.length}</span>}>
            Подписки
          </SectionTitle>
          <div className="space-y-2">
            {subscriptions.map((s) => {
              const usedPct =
                s.traffic_total_bytes > 0
                  ? Math.min(100, Math.round((s.traffic_used_bytes / s.traffic_total_bytes) * 100))
                  : 0;
              const expired = s.expires_on ? new Date(s.expires_on).getTime() < Date.now() : false;
              const daysLeft = s.expires_on
                ? Math.ceil((new Date(s.expires_on).getTime() - Date.now()) / 864e5)
                : null;
              const subNodes = profiles.filter((p) => p.subscription_id === s.id);
              const subOnline = subNodes.filter((p) => p.status === 'online' || p.status === 'degraded').length;
              const failed = s.last_sync_status === 'error';
              return (
                <article
                  key={s.id}
                  className="rounded-2xl border p-3.5"
                  style={{
                    borderColor: failed ? 'rgb(var(--danger) / 0.4)' : 'var(--line)',
                    background: 'var(--surface)',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <ExpandableText text={s.name} className="text-[13.5px] font-bold w-full" />
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                          style={{ background: 'var(--accent-soft)', color: 'rgb(var(--accent))' }}
                        >
                          {s.node_count} узлов
                        </span>
                        {expired && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                            style={{ background: 'rgb(var(--danger) / 0.14)', color: 'rgb(var(--danger))' }}
                          >
                            истекла
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => copy(s.url, `sub-${s.id}`)}
                        className="mt-1 flex items-center gap-1 text-[10.5px] text-muted font-mono truncate max-w-full tap"
                        title="Скопировать ссылку подписки"
                      >
                        {copiedKey === `sub-${s.id}` ? (
                          <Check className="w-3 h-3 shrink-0" style={{ color: 'rgb(var(--success))' }} />
                        ) : (
                          <Copy className="w-3 h-3 shrink-0" />
                        )}
                        <span className="truncate">{s.url}</span>
                      </button>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={syncingId === s.id}
                        onClick={() => handleSyncSubscription(s)}
                        className="tap-icon tap text-dim hover:text-[color:var(--text)]"
                        title="Обновить подписку"
                      >
                        <RefreshCw className={`w-4 h-4 ${syncingId === s.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete({ kind: 'sub', sub: s })}
                        className="tap-icon tap text-dim hover:text-[rgb(var(--danger))]"
                        title="Удалить подписку"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {s.traffic_total_bytes > 0 && (
                    <div className="mt-2.5">
                      <div className="flex justify-between text-[10.5px] text-muted mb-1">
                        <span>Трафик</span>
                        <span className="font-mono">
                          {formatBytes(s.traffic_used_bytes)} / {formatBytes(s.traffic_total_bytes)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${usedPct}%`,
                            background:
                              usedPct > 85
                                ? 'rgb(var(--danger))'
                                : usedPct > 60
                                ? 'rgb(var(--warning))'
                                : 'rgb(var(--success))',
                          }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2.5 text-[10.5px] text-muted">
                    <span>
                      Обновлено{' '}
                      {s.last_synced_at
                        ? new Date(s.last_synced_at).toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'никогда'}
                    </span>
                    {s.expires_on && (
                      <span style={{ color: expired ? 'rgb(var(--danger))' : daysLeft !== null && daysLeft <= 7 ? 'rgb(var(--warning))' : undefined }}>
                        До {new Date(s.expires_on).toLocaleDateString('ru-RU')}
                        {daysLeft !== null && !expired && ` · ${daysLeft} дн.`}
                      </span>
                    )}
                    <span>авто: {s.auto_update ? `каждые ${s.update_interval_hours} ч` : 'выкл'}</span>
                    {subNodes.length > 0 && (
                      <span style={{ color: 'rgb(var(--success))' }}>
                        {subOnline}/{subNodes.length} отвечают
                      </span>
                    )}
                  </div>

                  {!failed && s.last_sync_message && (
                    <div className="mt-2 flex items-start gap-1.5 text-[10.5px] rounded-xl px-2 py-1.5 text-dim"
                      style={{ background: 'var(--surface-2)' }}>
                      <Info className="w-3.5 h-3.5 shrink-0 mt-px opacity-70" />
                      <span className="leading-snug">{s.last_sync_message}</span>
                    </div>
                  )}

                  {failed && s.last_sync_message && (
                    <div
                      className="mt-2 flex items-start gap-1.5 text-[11px] rounded-xl p-2"
                      style={{ background: 'rgb(var(--danger) / 0.1)', color: 'rgb(var(--danger))' }}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="leading-snug">{s.last_sync_message}</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* ---------- Поиск ---------- */}
      {profiles.length > 0 && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск: Амстердам, Reality, 1.2.3.4"
              className={`${input} pl-9`}
              style={inputStyle}
            />
          </div>
          <div className="chip-rail">
            {(
              [
                ['all', 'Все'],
                ['high', 'Устойчивые'],
                ['medium', 'Средние'],
                ['low', 'Слабые'],
              ] as const
            ).map(([v, label]) => (
              <Chip key={v} active={protoFilter === v} onClick={() => setProtoFilter(v)}>
                {label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <ArrowUpDown className="w-3.5 h-3.5 text-muted" />
            <Chip active={sortMode === 'ping'} onClick={() => setSortMode('ping')}>
              Сначала быстрые
            </Chip>
            <Chip active={sortMode === 'subscription'} onClick={() => setSortMode('subscription')}>
              Как в подписке
            </Chip>
          </div>
          <p className="text-[10px] text-muted">Длинное название узла раскрывается нажатием.</p>
        </div>
      )}

      {/* ---------- Какой узел подойдёт ---------- */}
      {realScan && problem && problem !== 'no_problem' && recommended.length > 0 && (
        <section
          className="rounded-[1.5rem] border p-4 space-y-3"
          style={{
            borderColor: 'rgb(var(--accent) / 0.35)',
            background: 'color-mix(in srgb, rgb(var(--accent)) 7%, var(--surface))',
          }}
        >
          <div className="flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'rgb(var(--accent))' }} />
            <div className="min-w-0">
              <div className="text-[13px] font-bold leading-tight">
                Лучше всего подойдёт
              </div>
              <div className="text-[10.5px] text-muted leading-tight mt-0.5">
                замер: {PROBLEM_TEXT[problem].title.toLowerCase()}
              </div>
              <p className="text-[11.5px] text-dim leading-snug mt-1">
                {PROBLEM_TEXT[problem].hint} Выбор — по протоколу и последней проверке узлов, туннель
                не включается.
              </p>

              {looksSynthetic(profiles) && (
                <p
                  className="text-[10.5px] leading-snug mt-1.5 px-2 py-1.5 rounded-lg"
                  style={{ background: 'rgb(var(--warning) / 0.1)', color: 'rgb(var(--warning))' }}
                >
                  В подписке у всех узлов одинаковые хост и пинг — похоже на пример провайдера.
                  Порядок верный по протоколам, но реальную скорость такие данные не показывают.
                </p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            {recommended.map((rec) => (
              <button
                key={rec.profile.id}
                type="button"
                onClick={() => setQrNode(rec.profile)}
                className="w-full text-left rounded-xl px-3 py-2 tap flex items-center gap-2.5"
                style={{ background: 'var(--surface)' }}
              >
                <CountryBadge code={rec.profile.country_code} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold truncate">
                    {rec.profile.name}
                  </span>
                  <span className="block text-[10.5px] text-dim truncate">{nodeSubtitle(rec.profile)}</span>
                  <span className="block text-[10.5px] text-muted truncate">{rec.why}</span>
                </span>
                <span
                  className="text-[12px] font-mono font-bold shrink-0"
                  style={{ color: 'rgb(var(--accent))' }}
                >
                  {rec.score}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCheckOne(rec.profile);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      void handleCheckOne(rec.profile);
                    }
                  }}
                  className="shrink-0 w-7 h-7 rounded-lg grid place-items-center tap"
                  style={{ background: 'var(--surface-2)', color: 'rgb(var(--accent))' }}
                  title="Проверить пинг этого узла"
                  aria-label={`Проверить пинг ${rec.profile.name}`}
                >
                  {checkingId === rec.profile.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5" />
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ---------- Список узлов ---------- */}
      {profiles.length === 0 ? (
        <div
          className="rounded-[1.5rem] border"
          style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
        >
          <EmptyState
            icon={<Shield className="w-5 h-5" />}
            title="Узлов пока нет"
            text="Вставьте ссылку подписки от провайдера — приложение само распознает все узлы, проставит страны и проверит доступность каждого."
            action={
              <Button variant="primary" size="md" icon={<Link2 className="w-4 h-4" />} onClick={openSubModal}>
                Добавить подписку
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* Одна кнопка на весь список: проверить пинг всех узлов сразу, без VPN */}
          <div
            className="rounded-2xl border px-3 py-2.5 flex items-center gap-2.5"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-bold leading-tight">
                TCP-доступность узлов
                {lastCheckedLabel && (
                  <span className="text-[10.5px] font-normal text-muted"> · {lastCheckedLabel}</span>
                )}
              </div>
              <div className="text-[10.5px] text-muted leading-snug mt-0.5">
                {checkingAll && checkProgress
                  ? `Проверяем: ${checkProgress.done} из ${checkProgress.total}`
                  : `${onlineTotal} из ${profiles.length} отвечают`}
              </div>
            </div>
            <Button
              variant={checkingAll ? 'outline' : 'soft'}
              size="sm"
              icon={checkingAll ? <Square className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}
              onClick={() => void handleCheckAll()}
            >
              {checkingAll ? 'Остановить' : 'Проверить'}
            </Button>
          </div>
          {connection?.vpn_detected && (
            <Notice tone="info" icon={<Info className="w-4 h-4" />}>
              Включён VPN, поэтому проверка узлов идёт через физическую сеть в обход туннеля — иначе TCP
              принимал бы сам VPN-клиент и все серверы показывали одинаковые миллисекунды. Если система
              запрещает прямой доступ, число не выдумывается: выключите VPN и повторите.
            </Notice>
          )}
          {connection?.split_tunnel && (
            <Notice tone="warn" icon={<Info className="w-4 h-4" />}>
              VPN включён, но Android пускает трафик «ПульсСети» мимо туннеля (раздельный туннель в клиенте).
              Проверки сайтов и скорости в таком режиме показывают обычный интернет. Добавьте приложение
              в проксируемые в настройках VPN-клиента.
            </Notice>
          )}
          {isNativeApp() && (
            <div className="rounded-2xl border p-3 space-y-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-bold leading-tight">Реальная задержка подключения</div>
                  <div className="text-[10.5px] text-muted leading-snug mt-0.5">
                    HTTP 204 через активное подключение, медиана прогретых запросов — как real delay в v2rayNG и NekoBox.
                    Проверяет весь путь, включая выход сервера, а не только открытый порт.
                  </div>
                </div>
                <Button variant="soft" size="sm" loading={realDelayBusy} icon={<Zap className="w-3.5 h-3.5" />} onClick={() => void handleRealDelay()}>
                  Измерить
                </Button>
              </div>
              {realDelay && (
                <div className="text-[11.5px] font-semibold" style={{ color: realDelay.ok ? 'rgb(var(--success))' : 'rgb(var(--warning))' }}>
                  {realDelay.ok ? `${formatTcpLatency(realDelay.latencyMs)} · ${realDelay.route === 'vpn' ? 'через VPN' : 'напрямую'}` : realDelay.reason}
                  {realDelay.ok && realDelay.minMs != null && realDelay.maxMs != null
                    ? ` · разброс ${formatTcpLatency(realDelay.minMs)}…${formatTcpLatency(realDelay.maxMs)}` : ''}
                </div>
              )}
              {profiles.length > 0 && (
                <label className="block text-[10.5px] text-dim">
                  Для какого конфига сохранить замер
                  <select
                    value={realDelayProfileId ?? ''}
                    onChange={(event) => setRealDelayProfileId(event.target.value ? Number(event.target.value) : null)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
                    style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--text)' }}
                  >
                    <option value="">Определить по выходному IP</option>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {grouped.map(([groupName, nodes]) => {
            const isCollapsed = collapsed[groupName];
            const onlineCount = nodes.filter((n) => n.status === 'online' || n.status === 'degraded').length;
            return (
              <section
                key={groupName}
                className="rounded-2xl border overflow-hidden"
                style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
              >
                <button
                  type="button"
                  onClick={() => setCollapsed((prev) => ({ ...prev, [groupName]: !prev[groupName] }))}
                  className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left tap"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-muted shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted shrink-0" />
                  )}
                  <span className="text-[12.5px] font-bold truncate flex-1">{groupName}</span>
                  <span className="text-[11px] font-mono shrink-0" style={{ color: 'rgb(var(--success))' }}>
                    {onlineCount}/{nodes.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="border-t" style={{ borderColor: 'var(--line)' }}>
                    {nodes.map((p) => {
                      const tone = statusTone(p.status);
                      const color =
                        tone === 'ok'
                          ? 'rgb(var(--success))'
                          : tone === 'warn'
                          ? 'rgb(var(--warning))'
                          : tone === 'idle'
                          ? 'var(--text-muted)'
                          : 'rgb(var(--danger))';
                      return (
                        <div
                          key={p.id}
                          className="px-3.5 py-2.5 border-b last:border-b-0"
                          style={{ borderColor: 'var(--line)' }}
                        >
                          <div className="flex items-center gap-2.5">
                            <CountryBadge
                              code={p.country_code && p.country_code !== 'XX' ? p.country_code : guessCode(p.name, p.location)}
                              size={28}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <ExpandableText
                                  text={stripLeadingFlag(p.name)}
                                  className="text-[12.5px] font-semibold flex-1 leading-snug"
                                />
                                {Boolean(p.is_primary) && (
                                  <Star className="w-3 h-3 shrink-0" style={{ color: 'rgb(var(--accent))' }} />
                                )}
                                {Boolean(p.whitelist_bypass) && (
                                  <span
                                    className="text-[9.5px] font-bold px-1 py-0.5 rounded"
                                    style={{ background: 'rgb(var(--success) / 0.15)', color: 'rgb(var(--success))' }}
                                  >
                                    RU
                                  </span>
                                )}
                              </div>
                              <div className="text-[10.5px] text-muted font-mono truncate mt-0.5">
                                {p.host}:{p.port} · {p.protocol}
                              </div>
                              {p.notes && (
                                <div className="text-[9.5px] leading-snug mt-0.5 break-words" style={{ color: 'rgb(var(--warning))' }}>
                                  {p.notes}
                                </div>
                              )}
                            </div>
                            {/* Бейдж не должен съедать строку: «старая проба ·
                                повторите» занимал 177 px и сжимал название узла
                                в столбик по букве. Теперь он ограничен и режется. */}
                            <span
                              className="inline-flex min-w-0 max-w-[44%] items-center gap-1 text-[10.5px] font-bold px-1.5 py-1 rounded-md shrink-0 font-mono"
                              style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
                              title={nodeRealDelayLabel(p) || nodeLatencyLabel(p)}
                            >
                              <StatusIcon status={p.status} className="w-3 h-3 shrink-0" />
                              <span className="truncate">{nodeRealDelayLabel(p) || nodeLatencyLabel(p)}</span>
                            </span>
                          </div>

                          <div className="flex items-center gap-0.5 mt-1.5 -ml-1.5">
                            <IconAction
                              title="Проверить TCP"
                              onClick={() => handleCheckOne(p)}
                              loading={checkingId === p.id}
                              icon={<Zap className="w-3.5 h-3.5" />}
                            />
                            <IconAction
                              title="QR для телефона"
                              onClick={() => handleOpenQr(p)}
                              icon={<QrCode className="w-3.5 h-3.5" />}
                            />
                            {!p.is_primary && (
                              <IconAction
                                title="Сделать основным"
                                onClick={() => handleSetPrimary(p)}
                                icon={<Star className="w-3.5 h-3.5" />}
                              />
                            )}
                            <IconAction
                              title="Изменить"
                              onClick={() => openEdit(p)}
                              icon={<Pencil className="w-3.5 h-3.5" />}
                            />
                            <IconAction
                              title="Удалить"
                              onClick={() => setPendingDelete({ kind: 'node', node: p })}
                              icon={<Trash2 className="w-3.5 h-3.5" />}
                              danger
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* ================= ПОДПИСКА ================= */}
      <Sheet
        open={subModalOpen}
        onClose={() => setSubModalOpen(false)}
        title="Добавить подписку"
        subtitle="Ссылку выдаёт панель провайдера"
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Link2 className="w-4 h-4" />
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl" style={{ background: 'var(--surface-2)' }}>
            {(
              [
                ['url', 'Ссылка подписки', <Download key="d" className="w-3.5 h-3.5" />],
                ['links', 'Ссылки узлов', <FileText key="f" className="w-3.5 h-3.5" />],
              ] as const
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setSubTab(id);
                  setSubError(null);
                }}
                className={`h-9 rounded-lg text-[12px] font-bold inline-flex items-center justify-center gap-1.5 tap ${
                  subTab === id ? 'accent-solid' : 'text-dim'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {subTab === 'url' ? (
            <form onSubmit={handleAddSubscription} className="space-y-3">
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Ссылка подписки</span>
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  placeholder="https://panel.example.com/sub/…"
                  className={`${input} font-mono text-[12px]`}
                  style={inputStyle}
                />
              </label>

              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text.trim()) {
                        setSubUrl(text.trim());
                        showToast('info', 'Ссылка вставлена из буфера');
                      }
                    } catch {
                      showToast('warning', 'Нет доступа к буферу — вставьте вручную');
                    }
                  }}
                  className="h-8 px-2.5 rounded-full border text-[11.5px] font-semibold text-dim tap"
                  style={{ borderColor: 'var(--line)' }}
                >
                  Вставить из буфера
                </button>
                {IS_DEMO_BUILD && !isNativeApp() && (
                <button
                  type="button"
                  onClick={() => {
                    const origin = window.location.origin;
                    const base = !origin || origin === 'null' ? '' : origin;
                    setSubUrl(`${base}/api/sample-subscription`);
                    setSubName('Демо-подписка');
                    showToast('info', 'Подставлена демо-подписка');
                  }}
                  className="h-8 px-2.5 rounded-full border text-[11.5px] font-semibold text-dim tap"
                  style={{ borderColor: 'var(--line)' }}
                >
                  Попробовать демо
                </button>
                )}
              </div>

              <label className="block">
                <span className="block text-[11.5px] font-semibold text-dim mb-1.5">
                  Название <span className="text-muted font-normal">— необязательно</span>
                </span>
                <input
                  type="text"
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  placeholder="Например: мой провайдер"
                  className={input}
                  style={inputStyle}
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[11.5px] font-semibold text-dim mb-1.5">
                    Автообновление, ч
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={subInterval}
                    onChange={(e) => setSubInterval(Number(e.target.value) || 12)}
                    className={input}
                    style={inputStyle}
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => setSubAutoUpdate((v) => !v)}
                    className="w-full h-[42px] rounded-xl border text-[12px] font-semibold tap"
                    style={{
                      borderColor: 'var(--line)',
                      background: subAutoUpdate ? 'var(--accent-soft)' : 'var(--surface-2)',
                      color: subAutoUpdate ? 'rgb(var(--accent))' : 'var(--text-dim)',
                    }}
                  >
                    {subAutoUpdate ? 'Авто включено' : 'Авто выключено'}
                  </button>
                </div>
              </div>

              {subError && (
                <Notice tone="bad" icon={<AlertTriangle className="w-4 h-4" />}>
                  <div className="text-[11.5px] leading-relaxed break-words">{subError}</div>
                </Notice>
              )}

              {subSaving && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-[11.5px] text-dim">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Скачиваем подписку и ищем узлы…
                  </div>
                  <Skeleton className="h-1.5" />
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={subSaving}
                icon={<Download className="w-4 h-4" />}
              >
                {subSaving ? 'Загружаем…' : 'Загрузить подписку'}
              </Button>

              <p className="text-[10.5px] text-muted leading-relaxed">
                Понимаем base64-списки, Clash/YAML, sing-box JSON и отдельные ссылки VLESS, VMess,
                Trojan, Shadowsocks, Hysteria2, TUIC. Если адрес панели не открывается у вашего
                оператора — включите VPN и попробуйте снова.
              </p>
            </form>
          ) : (
            <form onSubmit={handleImportLinks} className="space-y-3">
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-dim mb-1.5">
                  Вставьте ссылки узлов или base64-подписку
                </span>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={7}
                  placeholder={'vless://…\nvmess://…\nss://…'}
                  className={`${input} font-mono text-[11px] resize-y`}
                  style={inputStyle}
                />
              </label>

              {subError && (
                <Notice tone="bad" icon={<AlertTriangle className="w-4 h-4" />}>
                  <div className="text-[11.5px] leading-relaxed break-words">{subError}</div>
                </Notice>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={importingLinks}
                icon={<FileText className="w-4 h-4" />}
              >
                Распознать узлы
              </Button>
            </form>
          )}
        </div>
      </Sheet>


      {/* ================= ПОДТВЕРЖДЕНИЕ УДАЛЕНИЯ ================= */}
      <ConfirmSheet
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'sub' ? 'Удалить подписку?' : 'Удалить узел?'}
        text={
          pendingDelete?.kind === 'sub'
            ? `«${pendingDelete.sub.name}» и все её узлы исчезнут из списка. Ссылку подписки можно будет добавить заново.`
            : pendingDelete?.kind === 'node'
            ? `«${stripLeadingFlag(pendingDelete.node.name)}» пропадёт из списка.`
            : ''
        }
        confirmLabel="Удалить"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          if (target.kind === 'sub') void handleDeleteSubscription(target.sub);
          else void handleDelete(target.node);
        }}
      />

      {/* ================= УЗЕЛ ВРУЧНУЮ ================= */}
      <Sheet
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Изменить узел' : 'Новый узел'}
        subtitle="Проверим доступность сразу после сохранения"
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Server className="w-4 h-4" />
          </div>
        }
        footer={
          <>
            <Button variant="ghost" size="md" block onClick={() => setModalOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="md"
              block
              loading={saving}
              onClick={() =>
                (document.getElementById('node-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Сохранить
            </Button>
          </>
        }
      >
        <form id="node-form" onSubmit={handleSave} className="space-y-3">
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Название</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="NL Амстердам — Reality"
              className={input}
              style={inputStyle}
            />
          </label>

          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Хост</span>
              <input
                type="text"
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="nl1.example.com"
                className={`${input} font-mono`}
                style={inputStyle}
              />
            </label>
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Порт</span>
              <input
                type="number"
                required
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 443)}
                className={`${input} font-mono`}
                style={inputStyle}
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Протокол</span>
            <select
              value={protocol}
              onChange={(e) => handleProtocolChange(e.target.value)}
              className={input}
              style={inputStyle}
            >
              {PROTOCOLS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.value}
                </option>
              ))}
            </select>
            {(() => {
              const p = PROTOCOLS.find((x) => x.value === protocol);
              if (!p) return null;
              const tone =
                p.dpi === 'high'
                  ? 'rgb(var(--success))'
                  : p.dpi === 'medium'
                  ? 'rgb(var(--warning))'
                  : 'rgb(var(--danger))';
              return (
                <p className="text-[10.5px] mt-1.5 leading-snug" style={{ color: tone }}>
                  {p.dpi === 'high' ? 'Хорошо обходит ТСПУ' : p.dpi === 'medium' ? 'Средняя устойчивость' : 'Часто блокируется'}
                  <span className="text-muted"> — {p.hint}</span>
                </p>
              );
            })()}
          </label>

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Локация</span>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className={input}
                style={inputStyle}
              />
            </label>
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Код</span>
              <input
                type="text"
                maxLength={2}
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                className={`${input} font-mono uppercase text-center`}
                style={inputStyle}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => setWhitelistBypass((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-[12px] font-semibold tap"
            style={{
              borderColor: 'var(--line)',
              background: whitelistBypass ? 'rgb(var(--success) / 0.1)' : 'var(--surface-2)',
              color: whitelistBypass ? 'rgb(var(--success))' : 'var(--text-dim)',
            }}
          >
            <span>RU-каскад (обход белых списков)</span>
            {whitelistBypass ? <Check className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
          </button>
        </form>
      </Sheet>

      {/* ================= QR ================= */}
      <Sheet
        open={Boolean(qrNode)}
        onClose={() => setQrNode(null)}
        title={qrNode ? stripLeadingFlag(qrNode.name) : 'QR'}
        subtitle="Отсканируйте в VPN-клиенте на телефоне"
        size="sm"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <QrCode className="w-4 h-4" />
          </div>
        }
      >
        {qrNode && (
          <div className="space-y-3">
            <div className="flex justify-center">
              <div className="rounded-2xl bg-white p-3">
                {qrLoading ? (
                  <div className="w-[200px] h-[200px] grid place-items-center">
                    <Loader2 className="w-6 h-6 animate-spin text-muted" />
                  </div>
                ) : qrValue ? (
                  <QRCodeCanvas value={qrValue} size={200} level="M" includeMargin={false} />
                ) : (
                  <div className="w-[200px] h-[200px] grid place-items-center text-[12px] text-muted text-center px-4">
                    Ссылка для этого узла недоступна — добавьте узел из подписки
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 justify-center text-[11px] text-muted font-mono">
              {qrNode.host}:{qrNode.port} · {qrNode.protocol}
            </div>
            <Button
              variant="soft"
              size="md"
              block
              icon={<Copy className="w-4 h-4" />}
              onClick={() => copy(qrValue, `qr-${qrNode.id}`)}
            >
              {copiedKey === `qr-${qrNode.id}` ? 'Скопировано' : 'Скопировать ссылку узла'}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
};

const IconAction: React.FC<{
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
  danger?: boolean;
}> = ({ title, icon, onClick, loading, danger }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={loading}
    className={`tap-icon tap text-dim ${danger ? 'hover:text-[rgb(var(--danger))]' : 'hover:text-[rgb(var(--accent))]'}`}
  >
    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
  </button>
);
