import React, { useMemo, useState } from 'react';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Plus,
  RefreshCw,
  Zap,
  Star,
  Pencil,
  Trash2,
  CheckCircle2,
  Clock,
  XCircle,
  X,
  Loader2,
  GitBranch,
  Globe,
  Link2,
  QrCode,
  Download,
  Upload,
  ChevronDown,
  ChevronRight,
  Search,
  Copy,
  Check,
  Signal,
  Radio,
  FileText,
  AlertTriangle,
  Link,
  Server,
} from 'lucide-react';
import type {
  ClientConnectionInfo,
  VpnProfile,
  VpnSubscription,
} from '../types';
import { apiFetch } from '../lib/api';
import { QRCodeCanvas } from 'qrcode.react';

interface VpnMonitorViewProps {
  profiles: VpnProfile[];
  setProfiles: React.Dispatch<React.SetStateAction<VpnProfile[]>>;
  subscriptions: VpnSubscription[];
  setSubscriptions: React.Dispatch<React.SetStateAction<VpnSubscription[]>>;
  connection: ClientConnectionInfo | null;
  connLoading: boolean;
  onRefreshConnection: () => void;
  darkMode: boolean;
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

// Убирает ведущий эмодзи-флаг/иконку из имени узла: флаг уже рисуется отдельно по country_code
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

// Флаг страны: сначала по country_code, затем по названию/локации узла
const nodeFlag = (code?: string, ...labels: Array<string | undefined>) => {
  if (code && code.length === 2 && code !== 'XX') return COUNTRY_FLAG(code);
  const hay = labels.filter(Boolean).join(' ');
  const hit = COUNTRY_BY_NAME.find(([re]) => re.test(hay));
  return hit ? COUNTRY_FLAG(hit[1]) : '🌐';
};

const COUNTRY_FLAG = (code: string) => {
  if (!code || code.length !== 2 || code === 'XX') return '🌐';
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split('')
      .map((c) => 127397 + c.charCodeAt(0))
  );
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

export const VpnMonitorView: React.FC<VpnMonitorViewProps> = ({
  profiles,
  setProfiles,
  subscriptions,
  setSubscriptions,
  connection,
  connLoading,
  onRefreshConnection,
  darkMode,
  showToast,
}) => {
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [protoFilter, setProtoFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ---------- Add/Edit VPN node modal ----------
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

  // ---------- Subscription modal ----------
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subTab, setSubTab] = useState<'url' | 'links'>('url');
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [subAutoUpdate, setSubAutoUpdate] = useState(true);
  const [subInterval, setSubInterval] = useState(12);
  const [subSaving, setSubSaving] = useState(false);
  const [importText, setImportText] = useState('');
  const [importingLinks, setImportingLinks] = useState(false);
  const [preview, setPreview] = useState<
    Array<{ name: string; protocol: string; host: string; port: number; location: string; country_code: string }>
  >([]);

  // ---------- QR modal ----------
  const [qrNode, setQrNode] = useState<VpnProfile | null>(null);
  const [qrValue, setQrValue] = useState<string>('');
  const [qrLoading, setQrLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
          const next = res.profile.is_primary
            ? prev.map((x) => ({ ...x, is_primary: false }))
            : prev;
          return [res.profile, ...next];
        });
        showToast('success', `Узел «${res.profile.name}» добавлен и проверен по TCP`);
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения VPN');
    } finally {
      setSaving(false);
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
        res.profile.status === 'online'
          ? 'success'
          : res.profile.status === 'degraded'
          ? 'warning'
          : 'error',
        `${res.profile.name}: ${
          res.profile.status === 'online'
            ? `онлайн, ${res.profile.latency_ms} мс`
            : res.profile.status === 'degraded'
            ? `повышенный пинг ${res.profile.latency_ms} мс`
            : 'TCP-хендшейк не проходит (блок ТСПУ?)'
        }`
      );
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка проверки узла');
    } finally {
      setCheckingId(null);
    }
  };

  const handleCheckAll = async () => {
    setCheckingAll(true);
    try {
      const res = await apiFetch<{ profiles: VpnProfile[] }>('/api/vpn-profiles/check-all', {
        method: 'POST',
      });
      setProfiles(res.profiles);
      const online = res.profiles.filter((p) => p.status === 'online').length;
      showToast('success', `Проверено узлов: ${res.profiles.length} (онлайн: ${online})`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка массовой проверки');
    } finally {
      setCheckingAll(false);
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
      showToast('success', `«${p.name}» выбран основным узлом`);
    } catch {
      setProfiles(backup);
      showToast('error', 'Не удалось обновить основной VPN');
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
      showToast('info', `Узел «${p.name}» удалён`);
    } catch {
      setProfiles(backup);
      showToast('error', 'Ошибка удаления узла');
    }
  };

  // ---------- Subscription handling ----------
  const openSubModal = () => {
    setSubUrl('');
    setSubName('');
    setSubAutoUpdate(true);
    setSubInterval(12);
    setImportText('');
    setPreview([]);
    setSubTab('url');
    setSubModalOpen(true);
  };

  const handleAddSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subUrl.trim()) {
      showToast('warning', 'Вставьте ссылку подписки');
      return;
    }
    setSubSaving(true);
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
      showToast(
        'success',
        `Подписка загружена: ${res.imported} серверов, онлайн ${res.online}`
      );
      setSubModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось загрузить подписку');
    } finally {
      setSubSaving(false);
    }
  };

  const handleImportLinks = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importText.trim()) return;
    setImportingLinks(true);
    try {
      const res = await apiFetch<{
        imported: number;
        profiles: VpnProfile[];
        preview: typeof preview;
      }>('/api/vpn-profiles/import', {
        method: 'POST',
        body: JSON.stringify({ text: importText.trim(), group_name: 'Импорт вручную' }),
      });
      setProfiles(res.profiles);
      setPreview(res.preview);
      showToast('success', `Импортировано серверов: ${res.imported}`);
      if (res.imported > 0) setSubModalOpen(false);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Не удалось распознать ссылки'
      );
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
      showToast('success', `«${s.name}»: обновлено ${res.imported} серверов`);
    } catch (err) {
      setSubscriptions((prev) =>
        prev.map((item) =>
          item.id === s.id
            ? {
                ...item,
                last_sync_status: 'error',
                last_sync_message: err instanceof Error ? err.message : 'Ошибка синхронизации',
              }
            : item
        )
      );
      showToast('error', err instanceof Error ? err.message : 'Ошибка синхронизации');
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
      const res = await apiFetch<{ qr: string; target: string }>(
        `/api/vpn-profiles/${p.id}/qr`
      );
      setQrValue(res.target);
    } catch {
      // остаётся значение raw_link
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
      showToast('error', 'Браузер запретил доступ к буферу обмена');
    }
  };

  // ---------- Derived data ----------
  const filteredProfiles = useMemo(() => {
    return profiles.filter((p) => {
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
  }, [profiles, search, protoFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, VpnProfile[]>();
    for (const p of filteredProfiles) {
      const key = p.subscription_id
        ? subscriptions.find((s) => s.id === p.subscription_id)?.name || p.group_name || 'Подписка'
        : 'Мои серверы';
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
    const latencies = profiles
      .map((p) => p.latency_ms)
      .filter((v): v is number => typeof v === 'number');
    const best = profiles
      .filter((p) => p.status === 'online' && p.latency_ms)
      .sort((a, b) => (a.latency_ms || 0) - (b.latency_ms || 0))[0];
    return {
      total,
      online,
      degraded,
      blocked,
      avg: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null,
      best,
    };
  }, [profiles]);

  const card = darkMode ? 'bg-slate-900/65 border-slate-800' : 'bg-white border-slate-200 shadow-sm';
  const inputCls = `w-full px-3.5 py-2.5 rounded-xl border text-sm ${
    darkMode ? 'bg-slate-950 border-slate-800 text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
  }`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">VPN-клиент и мониторинг</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Подписки, импорт ссылок, пинг узлов и перенос профиля на телефон по QR
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {profiles.length > 0 && (
            <button
              type="button"
              disabled={checkingAll}
              onClick={handleCheckAll}
              className={`px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-semibold flex items-center gap-1.5 ${
                darkMode
                  ? 'bg-slate-900 border-slate-800 text-slate-200 hover:bg-slate-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <RefreshCw className={`w-4 h-4 ${checkingAll ? 'animate-spin' : ''}`} />
              Пинг всех
            </button>
          )}

          <button
            type="button"
            onClick={openSubModal}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-lg shadow-emerald-500/20"
          >
            <Link2 className="w-4 h-4" />
            Добавить подписку
          </button>

          <button
            type="button"
            onClick={openCreate}
            className="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-lg shadow-sky-500/20"
          >
            <Plus className="w-4 h-4" />
            Узел вручную
          </button>
        </div>
      </div>

      {/* Live current device card */}
      <div
        className={`rounded-3xl border p-5 sm:p-6 ${
          connection?.vpn_detected
            ? darkMode
              ? 'bg-gradient-to-r from-amber-950/60 via-slate-900 to-slate-900 border-amber-500/40'
              : 'bg-amber-50 border-amber-300'
            : darkMode
            ? 'bg-slate-900/70 border-slate-800'
            : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div
              className={`p-3 rounded-2xl border shrink-0 ${
                connection?.vpn_detected
                  ? 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                  : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-400'
              }`}
            >
              {connection?.vpn_detected ? (
                <ShieldAlert className="w-7 h-7" />
              ) : (
                <ShieldCheck className="w-7 h-7" />
              )}
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-extrabold uppercase tracking-wider text-sky-400">
                  Текущее соединение устройства
                </span>
                <span
                  className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                    connection?.vpn_detected
                      ? 'bg-amber-500 text-slate-950'
                      : 'bg-emerald-500 text-slate-950'
                  }`}
                >
                  {connection?.vpn_detected ? 'VPN АКТИВЕН' : 'ПРЯМОЕ ПОДКЛЮЧЕНИЕ'}
                </span>
              </div>

              <h2 className="text-lg sm:text-xl font-bold mt-1">
                {connection
                  ? `${COUNTRY_FLAG(connection.country_code)} ${connection.country_name}${
                      connection.city ? `, ${connection.city}` : ''
                    } — ${connection.isp}`
                  : 'Определение сетевого маршрута...'}
              </h2>

              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400 mt-1.5 font-mono">
                <span>IP: {connection?.ip || '...'}</span>
                {connection?.asn && <span>ASN: {connection.asn}</span>}
                <span>
                  {connection?.is_hosting
                    ? 'Дата-центр / VPS'
                    : connection?.is_mobile
                    ? 'Мобильная сеть (LTE)'
                    : 'Домашний / проводной'}
                </span>
              </div>

              {connection?.vpn_reasons && connection.vpn_reasons.length > 0 && (
                <div className="mt-2.5 text-xs text-amber-400 space-y-0.5">
                  {connection.vpn_reasons.map((r, i) => (
                    <div key={i}>• {r}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={connLoading}
            onClick={onRefreshConnection}
            className={`px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-2 self-start md:self-center shrink-0 ${
              darkMode
                ? 'bg-slate-950 border-slate-800 hover:bg-slate-800 text-slate-200'
                : 'bg-white border-slate-300 hover:bg-slate-50 text-slate-800'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${connLoading ? 'animate-spin' : ''}`} />
            Перепроверить
          </button>
        </div>
      </div>

      {/* Stats */}
      {profiles.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Всего серверов', value: stats.total, icon: Server, tone: 'text-sky-400' },
            { label: 'Онлайн', value: stats.online, icon: CheckCircle2, tone: 'text-emerald-400' },
            { label: 'Замедлены', value: stats.degraded, icon: Clock, tone: 'text-amber-400' },
            { label: 'Заблокированы', value: stats.blocked, icon: XCircle, tone: 'text-rose-400' },
          ].map((s) => (
            <div key={s.label} className={`rounded-2xl border p-4 ${card}`}>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-400 font-bold">
                <s.icon className={`w-3.5 h-3.5 ${s.tone}`} />
                {s.label}
              </div>
              <div className="mt-2 text-2xl font-black">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Subscriptions */}
      {subscriptions.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-400" />
              Подписки ({subscriptions.length})
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {subscriptions.map((s) => {
              const usedPct =
                s.traffic_total_bytes > 0
                  ? Math.min(100, Math.round((s.traffic_used_bytes / s.traffic_total_bytes) * 100))
                  : 0;
              const expired = s.expires_on ? new Date(s.expires_on).getTime() < Date.now() : false;
              return (
                <div
                  key={s.id}
                  className={`rounded-2xl border p-4 ${card} ${
                    s.last_sync_status === 'error' ? 'border-rose-500/40' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-bold text-sm truncate">{s.name}</h3>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          {s.node_count} узлов
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-300 border border-slate-500/30 uppercase">
                          {s.format}
                        </span>
                        {expired && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30">
                            истекла
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => copy(s.url, `sub-${s.id}`)}
                        className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-sky-400 font-mono truncate max-w-full"
                        title="Скопировать ссылку подписки"
                      >
                        {copiedKey === `sub-${s.id}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span className="truncate">{s.url}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={syncingId === s.id}
                        onClick={() => handleSyncSubscription(s)}
                        className="p-2 rounded-lg text-slate-400 hover:text-emerald-400 transition-colors"
                        title="Обновить подписку"
                      >
                        <RefreshCw
                          className={`w-4 h-4 ${syncingId === s.id ? 'animate-spin' : ''}`}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSubscription(s)}
                        className="p-2 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                        title="Удалить подписку"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Traffic bar */}
                  {s.traffic_total_bytes > 0 && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                        <span>Трафик</span>
                        <span className="font-mono">
                          {formatBytes(s.traffic_used_bytes)} / {formatBytes(s.traffic_total_bytes)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            usedPct > 85
                              ? 'bg-rose-500'
                              : usedPct > 60
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${usedPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-400">
                    <span>
                      Обновлено:{' '}
                      {s.last_synced_at
                        ? new Date(s.last_synced_at).toLocaleString('ru-RU')
                        : 'никогда'}
                    </span>
                    {s.expires_on && (
                      <span>
                        До: {new Date(s.expires_on).toLocaleDateString('ru-RU')}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Radio className="w-3 h-3 text-emerald-400" />
                      Авто: {s.auto_update ? `каждые ${s.update_interval_hours} ч` : 'выкл'}
                    </span>
                  </div>

                  {s.last_sync_status === 'error' && s.last_sync_message && (
                    <div className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-400">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{s.last_sync_message}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      {profiles.length > 0 && (
        <div className={`rounded-2xl border p-3 flex flex-col sm:flex-row gap-2 ${card}`}>
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию, хосту или локации (Амстердам, Reality, 1.2.3.4)..."
              className={`${inputCls} pl-10`}
            />
          </div>
          <select
            value={protoFilter}
            onChange={(e) => setProtoFilter(e.target.value as typeof protoFilter)}
            className={`px-3 py-2.5 rounded-xl border text-xs font-semibold sm:w-56 ${
              darkMode
                ? 'bg-slate-950 border-slate-800 text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <option value="all">Любая устойчивость к ТСПУ</option>
            <option value="high">Высокая (Reality / AWG)</option>
            <option value="medium">Средняя (QUIC / SS)</option>
            <option value="low">Низкая (чистый WG / OpenVPN)</option>
          </select>
        </div>
      )}

      {/* Node list grouped */}
      {profiles.length === 0 ? (
        <div className={`rounded-3xl border p-10 text-center ${card}`}>
          <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/25 flex items-center justify-center mx-auto mb-4">
            <Shield className="w-7 h-7 text-sky-400" />
          </div>
          <h3 className="text-lg font-bold">Серверов пока нет</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            Вставьте ссылку подписки от вашего провайдера (Happ, Hiddify, v2rayN, Streisand) —
            мы сами распознаем все узлы, проставим флаги стран и проверим их доступность по TCP.
          </p>
          <div className="flex flex-wrap justify-center gap-2 mt-5">
            <button
              type="button"
              onClick={openSubModal}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm inline-flex items-center gap-2"
            >
              <Link2 className="w-4 h-4" />
              Добавить подписку
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="px-5 py-2.5 rounded-xl border border-slate-700 text-slate-200 font-bold text-sm inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Ввести узел вручную
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([groupName, nodes]) => {
            const isCollapsed = collapsed[groupName];
            return (
              <div key={groupName} className={`rounded-2xl border overflow-hidden ${card}`}>
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [groupName]: !prev[groupName] }))
                  }
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-800/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isCollapsed ? (
                      <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                    <span className="font-bold text-sm truncate">{groupName}</span>
                    <span className="text-[11px] text-slate-400 shrink-0">
                      {nodes.length} узл{nodes.length === 1 ? 'ел' : nodes.length < 5 ? 'а' : 'ов'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] shrink-0">
                    <span className="text-emerald-400 font-bold">
                      {nodes.filter((n) => n.status === 'online').length} online
                    </span>
                    {nodes.filter((n) => n.status === 'blocked').length > 0 && (
                      <span className="text-rose-400 font-bold">
                        {nodes.filter((n) => n.status === 'blocked').length} block
                      </span>
                    )}
                  </div>
                </button>

                {!isCollapsed && (
                  <div className="border-t border-slate-800/60 divide-y divide-slate-800/50">
                    {nodes.map((p) => {
                      const isOnline = p.status === 'online';
                      const isDegraded = p.status === 'degraded';
                      return (
                        <div
                          key={p.id}
                          className={`px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
                            p.is_primary ? 'bg-sky-500/5' : ''
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className="text-xl leading-none shrink-0">
                              {nodeFlag(p.country_code, p.name, p.location)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-sm truncate">{stripLeadingFlag(p.name)}</span>
                                {Boolean(p.is_primary) && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30 inline-flex items-center gap-0.5">
                                    <Star className="w-2.5 h-2.5 fill-current" /> основной
                                  </span>
                                )}
                                {Boolean(p.whitelist_bypass) && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                    RU-каскад
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400 mt-0.5">
                                <span className="font-mono">
                                  {p.host}:{p.port}
                                </span>
                                <span>{p.location}</span>
                                <span className="text-slate-500">{p.protocol}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg ${
                                isOnline
                                  ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/25'
                                  : isDegraded
                                  ? 'text-amber-400 bg-amber-500/10 border border-amber-500/25'
                                  : 'text-rose-400 bg-rose-500/10 border border-rose-500/25'
                              }`}
                            >
                              {isOnline ? (
                                <Signal className="w-3 h-3" />
                              ) : isDegraded ? (
                                <Clock className="w-3 h-3" />
                              ) : (
                                <XCircle className="w-3 h-3" />
                              )}
                              {p.latency_ms ? `${p.latency_ms} мс` : isOnline ? 'online' : isDegraded ? 'shaping' : 'block'}
                            </span>

                            <div className="flex items-center gap-0.5">
                              <button
                                type="button"
                                disabled={checkingId === p.id}
                                onClick={() => handleCheckOne(p)}
                                className="p-2 rounded-lg text-slate-400 hover:text-sky-400 transition-colors"
                                title="TCP-пинг"
                              >
                                {checkingId === p.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Zap className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenQr(p)}
                                className="p-2 rounded-lg text-slate-400 hover:text-violet-400 transition-colors"
                                title="QR-код для телефона"
                              >
                                <QrCode className="w-4 h-4" />
                              </button>
                              {!p.is_primary && (
                                <button
                                  type="button"
                                  onClick={() => handleSetPrimary(p)}
                                  className="p-2 rounded-lg text-slate-400 hover:text-amber-400 transition-colors"
                                  title="Сделать основным"
                                >
                                  <Star className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => openEdit(p)}
                                className="p-2 rounded-lg text-slate-400 hover:text-sky-400 transition-colors"
                                title="Редактировать"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(p)}
                                className="p-2 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                                title="Удалить"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ================= SUBSCRIPTION / IMPORT MODAL ================= */}
      {subModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div
            className={`w-full max-w-xl rounded-3xl border p-6 shadow-2xl my-8 ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <Link2 className="w-5 h-5 text-emerald-400" />
                Добавить VPN в клиент
              </h3>
              <button
                type="button"
                onClick={() => setSubModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Подписка (subscription URL) или прямая ссылка на сервер. Форматы: VLESS/Reality,
              VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard, Clash YAML и base64-подписки.
            </p>

            <div className="flex gap-1 p-1 rounded-xl bg-slate-950/60 border border-slate-800 mb-4">
              <button
                type="button"
                onClick={() => setSubTab('url')}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 ${
                  subTab === 'url'
                    ? 'bg-emerald-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                Ссылка подписки
              </button>
              <button
                type="button"
                onClick={() => setSubTab('links')}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 ${
                  subTab === 'links'
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Импорт ссылок / base64
              </button>
            </div>

            {subTab === 'url' ? (
              <form onSubmit={handleAddSubscription} className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Ссылка подписки (subscription URL) *
                  </label>
                  <input
                    type="url"
                    required
                    value={subUrl}
                    onChange={(e) => setSubUrl(e.target.value)}
                    placeholder="https://panel.example.com/api/v1/client/subscribe?token=..."
                    className={`${inputCls} font-mono text-xs`}
                  />
                  <p className="text-[11px] text-slate-500 mt-1.5 flex items-start gap-1">
                    <Link className="w-3 h-3 mt-0.5 shrink-0" />
                    Ссылку выдают панели Happ / Remnawave / Marzban / 3x-ui / Outline
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      // На file:// и внутри sandboxed-iframe origin бывает 'null' — тогда шлём относительный путь
                      const origin = window.location.origin;
                      const base = !origin || origin === 'null' ? '' : origin;
                      setSubUrl(`${base}/api/sample-subscription`);
                      setSubName('Демо-подписка (8 узлов)');
                      showToast('info', 'Подставлена демо-подписка — нажмите «Загрузить подписку»');
                    }}
                    className="mt-2 text-[11px] font-bold text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
                  >
                    Нет своей подписки? Попробовать демо-подписку из 8 узлов →
                  </button>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Название (необязательно)
                    </label>
                    <input
                      type="text"
                      value={subName}
                      onChange={(e) => setSubName(e.target.value)}
                      placeholder="Например: Мой провайдер"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Автообновление, часов
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={subInterval}
                      onChange={(e) => setSubInterval(Number(e.target.value))}
                      className={inputCls}
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={subAutoUpdate}
                    onChange={(e) => setSubAutoUpdate(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>Автоматически подтягивать изменения серверов</span>
                </label>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setSubModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-slate-200"
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    disabled={subSaving}
                    className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm inline-flex items-center gap-2"
                  >
                    {subSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Загружаем и парсим...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Загрузить подписку
                      </>
                    )}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleImportLinks} className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Ссылки или base64-подписка *
                  </label>
                  <textarea
                    required
                    rows={7}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={`vless://uuid@nl.example.com:443?security=reality&sni=microsoft.com#🇳🇱 Нидерланды\nvmess://eyJhZGQiOi...\nss://YWVzLTI1Ni1nY206...@fi.example.com:8388#🇫🇮 Хельсинки\ntrojan://pass@de.example.com:443#🇩🇪 Франкфурт`}
                    className={`${inputCls} font-mono text-[11px] leading-relaxed`}
                  />
                </div>

                {preview.length > 0 && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <div className="text-xs font-bold text-emerald-400 mb-1.5">
                      Распознано серверов: {preview.length}
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {preview.map((n, i) => (
                        <div key={i} className="text-[11px] text-slate-300 font-mono flex gap-2">
                          <span>{COUNTRY_FLAG(n.country_code)}</span>
                          <span className="truncate">{n.name}</span>
                          <span className="text-slate-500 ml-auto shrink-0">
                            {n.host}:{n.port}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setSubModalOpen(false)}
                    className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-slate-200"
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    disabled={importingLinks}
                    className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-sm inline-flex items-center gap-2"
                  >
                    {importingLinks ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Импортируем...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        Импортировать
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ================= QR MODAL ================= */}
      {qrNode && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className={`w-full max-w-sm rounded-3xl border p-6 shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold">Перенос на телефон</h3>
              <button
                type="button"
                onClick={() => setQrNode(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-2xl bg-white p-4 flex items-center justify-center">
              {qrLoading ? (
                <div className="w-[220px] h-[220px] flex items-center justify-center">
                  <Loader2 className="w-7 h-7 animate-spin text-slate-500" />
                </div>
              ) : (
                <QRCodeCanvas value={qrValue || `vpn://${qrNode.host}:${qrNode.port}`} size={220} />
              )}
            </div>

            <p className="text-xs text-slate-400 mt-3 text-center">
              Отсканируйте камерой в приложении Happ, v2rayNG, Streisand или Hiddify — профиль
              «{qrNode.name}» добавится автоматически.
            </p>

            <div className="mt-3 rounded-xl bg-slate-950/60 border border-slate-800 p-2.5">
              <div className="text-[10px] text-slate-500 mb-1 font-mono">
                {qrNode.host}:{qrNode.port} • {qrNode.protocol}
              </div>
              <button
                type="button"
                onClick={() => copy(qrValue || `vpn://${qrNode.host}:${qrNode.port}`, 'qr-link')}
                className="w-full text-[11px] text-sky-400 hover:text-sky-300 flex items-center justify-center gap-1.5 font-bold"
              >
                {copiedKey === 'qr-link' ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {qrNode.raw_link ? 'Скопировать ссылку подключения' : 'Скопировать адрес сервера'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= ADD / EDIT NODE MODAL ================= */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl my-8 ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">
                {editing ? 'Настройки узла' : 'Добавить узел вручную'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Название узла *</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Финляндия • Reality"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Протокол</label>
                  <select
                    value={protocol}
                    onChange={(e) => handleProtocolChange(e.target.value)}
                    className={inputCls}
                  >
                    {PROTOCOLS.map((pr) => (
                      <option key={pr.value} value={pr.value}>
                        {pr.value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-400 mb-1">IP или домен *</label>
                  <input
                    type="text"
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="vpn.example.com"
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Порт</label>
                  <input
                    type="number"
                    required
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className={`${inputCls} font-mono`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-400 mb-1">Локация</label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="Хельсинки, Финляндия"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Страна</label>
                  <input
                    type="text"
                    maxLength={2}
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                    placeholder="FI"
                    className={`${inputCls} font-mono uppercase`}
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Провайдер</label>
                  <input
                    type="text"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="Hetzner / Aeza / Yandex Cloud"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Устойчивость к ТСПУ</label>
                  <select
                    value={dpiResistance}
                    onChange={(e) =>
                      setDpiResistance(e.target.value as 'high' | 'medium' | 'low')
                    }
                    className={inputCls}
                  >
                    <option value="high">Высокая (Reality / AWG)</option>
                    <option value="medium">Средняя (QUIC / SS)</option>
                    <option value="low">Низкая (чистый протокол)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={whitelistBypass}
                    onChange={(e) => setWhitelistBypass(e.target.checked)}
                    className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span>
                    <strong>RU-каскад (анти-белый список)</strong> — входная нода внутри РФ
                  </span>
                </label>

                <label className="flex items-center gap-2.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isPrimary}
                    onChange={(e) => setIsPrimary(e.target.checked)}
                    className="rounded border-slate-700 text-sky-500 focus:ring-sky-500"
                  />
                  <span>Сделать основным узлом</span>
                </label>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Заметки</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="SNI маскировка, срок оплаты, особенности..."
                  className={inputCls}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-slate-200"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-sm"
                >
                  {saving ? 'Проверка и сохранение...' : editing ? 'Сохранить' : 'Добавить узел'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
