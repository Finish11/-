import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertOctagon,
  Plus,
  ThumbsUp,
  CheckCircle2,
  MapPin,
  Radio,
  Pencil,
  Trash2,
  Check,
  RotateCcw,
  Star,
  Search,
  X,
  Info,
  Share2,
  Cloud,
  CloudOff,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import {
  RUSSIAN_CARRIERS,
  RUSSIAN_REGIONS,
  type Incident,
  type ScanRecord,
  type User,
} from '../types';
import { apiFetch } from '../lib/api';
import { shareText } from '../lib/shareText';
import { IS_DEMO_BUILD } from '../lib/scanner';
import {
  communitySyncChanged,
  getCommunityEndpoint,
  newClientId,
  reconcileCommunitySync,
  setCommunityEndpoint,
  checkCommunityHealth,
  queueIncidentEdit,
  queueIncidentVote,
  queueIncidentDelete,
  pendingCommunityCount,
  belongsToEndpoint,
  synchronizeCommunity,
} from '../lib/community';
import { Sheet } from './ui/Sheet';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { Button, Chip, EmptyState } from './ui/kit';
import {
  loadFavorites,
  placeKey,
  placeSummary,
  saveFavorites,
  searchPlaces,
  type Place,
} from '../lib/places';

interface IncidentsViewProps {
  user: User;
  incidents: Incident[];
  setIncidents: React.Dispatch<React.SetStateAction<Incident[]>>;
  prefillFromScan: ScanRecord | null;
  onClearPrefill: () => void;
  /** Больше не используется: цвета берутся из CSS-переменных. Оставлен для совместимости вызова. */
  darkMode?: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const TYPE_LABEL: Record<Incident['incident_type'], string> = {
  whitelist: 'Белые списки',
  mobile_shutdown: 'Глушение 4G',
  cdn_block: 'Блок CDN',
  vpn_block: 'Блок VPN',
  dpi_wave: 'Замедление DPI',
};

const TYPE_COLOR: Record<Incident['incident_type'], string> = {
  whitelist: 'rgb(var(--danger))',
  mobile_shutdown: 'rgb(var(--danger))',
  cdn_block: 'rgb(var(--warning))',
  vpn_block: 'rgb(var(--warning))',
  dpi_wave: 'rgb(var(--accent))',
};

export const IncidentsView: React.FC<IncidentsViewProps> = ({
  user,
  incidents,
  setIncidents,
  prefillFromScan,
  onClearPrefill,
  showToast,
}) => {
  const [regionFilter, setRegionFilter] = useState('all');
  const [carrierFilter, setCarrierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'resolved'>('all');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Incident | null>(null);
  const [region, setRegion] = useState(user.region || 'Москва и МО');
  const [carrier, setCarrier] = useState(user.carrier || 'МТС');
  const [incidentType, setIncidentType] = useState<Incident['incident_type']>('whitelist');
  const [severity, setSeverity] = useState<Incident['severity']>('critical');
  const [status, setStatus] = useState<Incident['status']>('active');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ruSitesOk, setRuSitesOk] = useState(true);
  const [foreignSitesOk, setForeignSitesOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Incident | null>(null);
  const [communityUrl, setCommunityUrl] = useState(getCommunityEndpoint);
  const [communityDraft, setCommunityDraft] = useState(getCommunityEndpoint);
  const [communitySettingsOpen, setCommunitySettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState('');
  const syncingRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const mountedRef = useRef(true);
  const incidentsRef = useRef(incidents);
  useEffect(() => {
    incidentsRef.current = incidents;
  }, [incidents]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      syncQueuedRef.current = false;
    };
  }, []);

  // Избранные места: без аккаунта, без сервера, только на этом телефоне
  const [favorites, setFavorites] = useState<Place[]>(() => loadFavorites());
  const [placeQuery, setPlaceQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [placePickerOpen, setPlacePickerOpen] = useState(false);

  const addPlace = (place: Place) => {
    setFavorites((prev) => {
      if (prev.some((p) => p.id === place.id)) return prev;
      const next = [place, ...prev].slice(0, 12);
      saveFavorites(next);
      return next;
    });
    setPlaceQuery('');
    showToast('success', `«${place.name}» в избранном`);
  };

  const removePlace = (place: Place) => {
    setFavorites((prev) => {
      const next = prev.filter((p) => p.id !== place.id);
      saveFavorites(next);
      return next;
    });
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3 py-2.5 rounded-xl text-[13px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

  const cacheIncidents = useCallback(async (next: Incident[]) => {
    if (!IS_DEMO_BUILD) return;
    await apiFetch('/api/incidents/cache', {
      method: 'PUT',
      body: JSON.stringify({ incidents: next }),
    });
  }, []);

  const syncNow = useCallback(async (silent = false): Promise<void> => {
    if (!IS_DEMO_BUILD || !communityUrl) return;
    if (syncingRef.current) {
      syncQueuedRef.current = true;
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    let snapshot = incidentsRef.current;
    try {
      // До сетевого запроса переносим старые отчёты пользователя в очередь.
      // Встроенные демо-примеры никогда не отправляются в общую ленту.
      const withIds = snapshot.map((incident) => {
        if (incident.demo || !incident.is_owner || (incident.sync_endpoint && incident.sync_endpoint !== communityUrl)) return incident;
        if (!incident.client_id || incident.sync_state === 'local' || !incident.sync_endpoint) {
          return { ...incident, client_id: incident.client_id || newClientId(), sync_state: 'pending' as const,
            sync_dirty: true, sync_endpoint: communityUrl, updated_at: incident.updated_at || incident.created_at, sync_error: '' };
        }
        return incident;
      });
      if (withIds.some((incident, index) => incident !== snapshot[index])) {
        snapshot = withIds;
        incidentsRef.current = withIds;
        setIncidents(withIds);
        await cacheIncidents(withIds);
      }
      const result = await synchronizeCommunity(snapshot, user.id);
      if (!mountedRef.current) return;
      const current = incidentsRef.current;
      if (communitySyncChanged(snapshot, current)) syncQueuedRef.current = true;
      const next = reconcileCommunitySync(snapshot, current, result.incidents)
        .filter((item) => !(snapshot.some((old) => old.id === item.id && old.pending_delete) && !result.incidents.some((row) => row.id === item.id)));
      incidentsRef.current = next;
      setIncidents(next);
      await cacheIncidents(next);
      if (!mountedRef.current) return;
      if (result.fetched) setLastSyncAt(new Date().toISOString());
      setSyncError(result.error || (result.failed ? `Не доставлено изменений: ${result.failed}. Повтор при связи или кнопке синхронизации.` : ''));
      if (!silent) {
        showToast(
          result.failed > 0 || !result.fetched ? 'warning' : 'success',
          result.failed > 0 || !result.fetched
            ? `Синхронизировано частично: не отправлено ${result.failed}. Повторите позже.`
            : 'Общая лента сбоев синхронизирована'
        );
      }
    } catch (error) {
      if (mountedRef.current) setSyncError(error instanceof Error ? error.message : 'Не удалось синхронизировать сбои');
      if (!silent && mountedRef.current) showToast('error', error instanceof Error ? error.message : 'Не удалось синхронизировать сбои');
    } finally {
      syncingRef.current = false;
      if (mountedRef.current) setSyncing(false);
      if (mountedRef.current && syncQueuedRef.current) {
        syncQueuedRef.current = false;
        window.setTimeout(() => { void syncNow(true); }, 0);
      }
    }
  }, [communityUrl, setIncidents, cacheIncidents, showToast, user.id]);

  useEffect(() => {
    if (!communityUrl || !IS_DEMO_BUILD) return;
    void syncNow(true);
    const retry = () => { void syncNow(true); };
    window.addEventListener('online', retry);
    const visible = () => { if (document.visibilityState === 'visible') retry(); };
    const timer = window.setInterval(visible, 300_000);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('online', retry); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); };
  }, [communityUrl, syncNow]);

  useEffect(() => {
    if (prefillFromScan) {
      setEditing(null);
      setRegion(user.region || 'Москва и МО');
      setCarrier(user.carrier || 'МТС');
      const isWhitelist = prefillFromScan.verdict === 'WHITELIST_ACTIVE';
      const isJamming = prefillFromScan.verdict === 'TOTAL_JAMMING';
      setIncidentType(isWhitelist ? 'whitelist' : isJamming ? 'mobile_shutdown' : 'cdn_block');
      setSeverity('critical');
      setStatus('active');
      setTitle(
        isWhitelist
          ? `Белые списки у ${user.carrier}`
          : isJamming
          ? `Глушение мобильного интернета (${user.carrier})`
          : `Зарубежные сайты недоступны (${user.carrier})`
      );
      setDescription(
        `По замеру ПульсСети: сайты РФ — ${prefillFromScan.ru_ok_pct}%, глобальные CDN — ${
          prefillFromScan.global_ok_pct
        }%, доступно ${prefillFromScan.ok_sites + prefillFromScan.slow_sites} из ${
          prefillFromScan.total_sites
        }.`
      );
      setRuSitesOk(prefillFromScan.ru_ok_pct >= 50);
      setForeignSitesOk(prefillFromScan.global_ok_pct >= 50);
      setModalOpen(true);
      onClearPrefill();
    }
  }, [prefillFromScan, user.region, user.carrier, onClearPrefill]);

  const openCreate = (prefillRegion?: string) => {
    setEditing(null);
    setRegion(prefillRegion || user.region || 'Москва и МО');
    setCarrier(user.carrier || 'МТС');
    setIncidentType('whitelist');
    setSeverity('critical');
    setStatus('active');
    setTitle('');
    setDescription('');
    setRuSitesOk(true);
    setForeignSitesOk(false);
    setModalOpen(true);
  };

  const openEdit = (inc: Incident) => {
    setEditing(inc);
    setRegion(inc.region);
    setCarrier(inc.carrier);
    setIncidentType(inc.incident_type);
    setSeverity(inc.severity);
    setStatus(inc.status);
    setTitle(inc.title);
    setDescription(inc.description);
    setRuSitesOk(inc.ru_sites_ok);
    setForeignSitesOk(inc.foreign_sites_ok);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        const changed = queueIncidentEdit(editing, { region, carrier, incident_type: incidentType, severity, status,
          title, description, ru_sites_ok: ruSitesOk, foreign_sites_ok: foreignSitesOk,
          client_id: editing.client_id || newClientId() }, communityUrl);
        const next = incidentsRef.current.map((x) => x.id === editing.id ? changed : x);
        incidentsRef.current = next; setIncidents(next); await cacheIncidents(next);
        if (communityUrl) void syncNow();
        showToast('info', communityUrl ? 'Изменение сохранено на устройстве и ждёт доставки' : 'Изменение сохранено только на устройстве');
      } else {
        const res = await apiFetch<{ incident: Incident }>('/api/incidents', {
          method: 'POST',
          body: JSON.stringify({
            region,
            carrier,
            incident_type: incidentType,
            severity,
            title,
            description,
            ru_sites_ok: ruSitesOk,
            foreign_sites_ok: foreignSitesOk,
            client_id: IS_DEMO_BUILD ? newClientId() : undefined,
            sync_state: IS_DEMO_BUILD ? (communityUrl ? 'pending' : 'local') : undefined,
            sync_dirty: IS_DEMO_BUILD ? true : undefined,
            sync_endpoint: IS_DEMO_BUILD ? communityUrl : undefined,
            updated_at: IS_DEMO_BUILD ? new Date().toISOString() : undefined,
            desired_upvote: IS_DEMO_BUILD ? true : undefined,
          }),
        });
        const next = [res.incident, ...incidentsRef.current];
        incidentsRef.current = next; setIncidents(next); await cacheIncidents(next);
        if (IS_DEMO_BUILD && communityUrl) void syncNow();
        showToast(
          'success',
          IS_DEMO_BUILD
            ? communityUrl ? 'Отчёт сохранён на устройстве и поставлен в очередь доставки' : 'Отчёт сохранён только на устройстве'
            : 'Отчёт опубликован в сводке'
        );
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения отчёта');
    } finally {
      setSaving(false);
    }
  };

  const persistLocal = async (next: Incident[]) => {
    incidentsRef.current = next; setIncidents(next);
    try { await cacheIncidents(next); } catch { setSyncError('Очередь не сохранена. Не закрывайте приложение и повторите действие.'); return; }
    if (communityUrl) void syncNow();
  };
  const handleToggleUpvote = (inc: Incident) => {
    if (inc.demo) { showToast('info', 'Это пример, за него нельзя голосовать'); return; }
    void persistLocal(incidentsRef.current.map((x) => x.id === inc.id ? queueIncidentVote(x, communityUrl) : x));
  };
  const handleToggleResolved = (inc: Incident) => {
    if (!inc.is_owner) return;
    void persistLocal(incidentsRef.current.map((x) => x.id === inc.id ? queueIncidentEdit(x, { status: inc.status === 'active' ? 'resolved' : 'active' }, communityUrl) : x));
  };
  const handleDelete = (inc: Incident) => {
    if (!inc.is_owner) return;
    void persistLocal(!communityUrl || inc.sync_state === 'local' ? incidentsRef.current.filter((x) => x.id !== inc.id)
      : incidentsRef.current.map((x) => x.id === inc.id ? queueIncidentDelete(x, communityUrl) : x));
    showToast('info', communityUrl ? 'Удаление сохранено и ждёт доставки' : 'Отчёт удалён с устройства');
  };

  const handleShare = async (inc: Incident) => {
    const text = [
      `ПульсСети — ${TYPE_LABEL[inc.incident_type]}`,
      inc.title,
      `${inc.region} · ${inc.carrier}`,
      inc.description,
      `Сайты РФ открываются: ${inc.ru_sites_ok ? 'да' : 'нет'}. Зарубежные: ${inc.foreign_sites_ok ? 'да' : 'нет'}.`,
      `${inc.author_name}, ${new Date(inc.created_at).toLocaleString('ru-RU')}`,
      inc.demo ? 'Пример из демо-набора, не измерение пользователя.' : 'Отчёт создан пользователем приложения.',
    ].filter(Boolean).join('\n');
    try {
      const outcome = await shareText(`Сбой: ${inc.region}`, text);
      if (outcome === 'copied') showToast('success', 'Отчёт скопирован — можно опубликовать на любом сайте');
    } catch {
      showToast('error', 'Не удалось поделиться отчётом');
    }
  };

  const saveCommunitySettings = async () => {
    if (syncingRef.current) {
      showToast('info', 'Дождитесь завершения синхронизации перед сменой сервера');
      return;
    }
    try {
      setConnecting(true);
      const normalized = communityDraft.trim(); if (normalized) await checkCommunityHealth(normalized);
      const saved = await setCommunityEndpoint(normalized);
      setCommunityUrl(saved); setCommunityDraft(saved); setCommunitySettingsOpen(false); setSyncError('');
      showToast('success', saved ? 'Сервер проверен и подключён; начинаем доставку очереди' : 'Общий сервер отключён; новые отчёты останутся на устройстве');
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Некорректный адрес сервера');
    } finally { setConnecting(false); }
  };

  const visibleIncidents = incidents.filter((inc) => !inc.pending_delete);
  const isForeignEndpoint = (inc: Incident) => Boolean(communityUrl && inc.sync_endpoint && !belongsToEndpoint(inc, communityUrl));
  const foreignEndpointCount = visibleIncidents.filter(isForeignEndpoint).length;
  const pendingSync = pendingCommunityCount(visibleIncidents, communityUrl || undefined);
  const activeList = visibleIncidents.filter((i) => i.status === 'active');
  const whitelistRegionsCount = new Set(
    activeList.filter((i) => i.incident_type === 'whitelist').map((i) => i.region)
  ).size;
  const shutdownRegionsCount = new Set(
    activeList.filter((i) => i.incident_type === 'mobile_shutdown').map((i) => i.region)
  ).size;
  const totalUpvotes = visibleIncidents.reduce((sum, i) => sum + i.upvotes, 0);

  const filtered = useMemo(
    () =>
      visibleIncidents.filter((inc) => {
        if (regionFilter !== 'all' && inc.region !== regionFilter) return false;
        if (carrierFilter !== 'all' && inc.carrier !== carrierFilter) return false;
        if (statusFilter !== 'all' && inc.status !== statusFilter) return false;
        return true;
      }),
    [visibleIncidents, regionFilter, carrierFilter, statusFilter]
  );

  const uniqueRegionsInFeed = Array.from(new Set(visibleIncidents.map((i) => i.region)));

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-[22px] font-black tracking-tight">Карта сбоев</h1>
        <p className="text-[12.5px] text-dim leading-snug">
          {IS_DEMO_BUILD
            ? communityUrl
              ? 'Отчёты отправляются на общий сервер и объединяются с отметками других пользователей. Неотправленные остаются в локальной очереди.'
              : 'Пока отчёты сохраняются только на этом устройстве. Подключите общий HTTPS-сервер, чтобы они доходили до владельца и других пользователей.'
            : 'Регионы, где глушат мобильный интернет или включили белые списки. Отметки ставят такие же пользователи, как вы — каждая подписана автором и временем.'}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => openCreate()}
          >
            Сообщить о сбое
          </Button>
          {IS_DEMO_BUILD && (
            <>
              {communityUrl && (
                <Button variant="outline" size="md" loading={syncing || connecting} icon={<RefreshCw className="w-4 h-4" />} onClick={() => void syncNow()}>
                  Синхронизировать
                </Button>
              )}
              <Button variant="soft" size="md" icon={<Settings2 className="w-4 h-4" />} onClick={() => setCommunitySettingsOpen(true)}>
                {communityUrl ? 'Общий сервер' : 'Подключить сервер'}
              </Button>
            </>
          )}
        </div>
      </header>

      {IS_DEMO_BUILD && (
        <section className="rounded-2xl border p-3 flex items-start gap-2.5" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          {communityUrl ? <Cloud className="w-4.5 h-4.5 shrink-0" style={{ color: 'rgb(var(--success))' }} /> : <CloudOff className="w-4.5 h-4.5 shrink-0 text-muted" />}
          <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-dim">
            {communityUrl ? (
              <>Общий сервер: <span className="font-mono break-all">{communityUrl}</span>.
                {lastSyncAt ? ` Обновлено ${new Date(lastSyncAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.` : ' Проверяем соединение.'}
                {pendingSync ? ` Ждут доставки: ${pendingSync}.` : ' Очередь пуста.'}
                {foreignEndpointCount ? ` Отчётов для другого сервера: ${foreignEndpointCount} — они хранятся на устройстве и будут отправлены после подключения того адреса.` : ''}
                {syncError && <div className="mt-1" style={{ color: 'rgb(var(--danger))' }}>{syncError}</div>}</>
            ) : (
              <>Без сервера владелец не получит отчёты автоматически. Можно сохранить их на устройстве и отправить вручную через «Поделиться».</>
            )}
          </div>
        </section>
      )}

      {/* ---------- Избранные места ---------- */}
      <section
        className="rounded-[1.5rem] border p-3.5"
        style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-2">
          <Star className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--accent))' }} />
          <h2 className="text-[13px] font-bold flex-1">Избранные места</h2>
          <button
            type="button"
            onClick={() => setPlacePickerOpen(true)}
            className="text-[11.5px] font-semibold px-2 py-1 rounded-lg tap"
            style={{ background: 'var(--accent-soft)', color: 'rgb(var(--accent))' }}
          >
            + Добавить
          </button>
        </div>

        {favorites.length === 0 ? (
          <p className="text-[11.5px] text-dim leading-snug mt-2">
            Добавьте город или деревню — приложение покажет, что известно о сбоях именно там
            (например, Жижица под Куньей).
          </p>
        ) : (
          <div className="space-y-1.5 mt-2.5">
            {favorites.map((place) => {
              const sum = placeSummary(place, incidents);
              return (
                <div
                  key={place.id}
                  className="flex items-center gap-2 rounded-xl px-2.5 py-2"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold truncate">{place.name}</div>
                    <div className="text-[10.5px] text-dim leading-tight">
                      {place.region}
                      {sum.total > 0
                        ? ` · отчётов ${sum.total}${sum.active ? `, активных ${sum.active}` : ''}`
                        : ' · отчётов нет'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRegionFilter(place.region);
                      setStatusFilter('all');
                    }}
                    className="text-[11px] font-semibold px-2 py-1 rounded-lg tap shrink-0"
                    style={{ color: 'rgb(var(--accent))' }}
                  >
                    Показать
                  </button>
                  <button
                    type="button"
                    onClick={() => removePlace(place)}
                    aria-label={`Убрать ${place.name} из избранного`}
                    className="p-1 rounded-lg text-muted tap shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid grid-cols-3 gap-1.5">
        {[
          { label: 'Белые списки', value: whitelistRegionsCount, suffix: 'рег.', color: 'rgb(var(--danger))' },
          { label: 'Глушение', value: shutdownRegionsCount, suffix: 'рег.', color: 'rgb(var(--warning))' },
          { label: 'Подтверждений', value: totalUpvotes, suffix: '', color: 'rgb(var(--accent))' },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border px-2 py-2"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            <div className="text-[17px] font-black font-mono leading-none" style={{ color: tile.color }}>
              {tile.value}
            </div>
            <div className="text-[9.5px] text-dim leading-tight mt-1">
              {tile.label}
              {tile.suffix ? `, ${tile.suffix}` : ''}
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
            className={input}
            style={inputStyle}
          >
            <option value="all">Все регионы ({visibleIncidents.length})</option>
            {uniqueRegionsInFeed.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            value={carrierFilter}
            onChange={(e) => setCarrierFilter(e.target.value)}
            className={input}
            style={inputStyle}
          >
            <option value="all">Все операторы</option>
            {RUSSIAN_CARRIERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="chip-rail">
          {(['all', 'active', 'resolved'] as const).map((st) => (
            <Chip key={st} active={statusFilter === st} onClick={() => setStatusFilter(st)}>
              {st === 'all' ? 'Все' : st === 'active' ? 'Активные' : 'Восстановлено'}
            </Chip>
          ))}
        </div>
      </section>

      {incidents.some((i) => i.demo) && (
        <div
          className="rounded-xl border px-3 py-2 flex items-start gap-1.5"
          style={{ borderColor: 'rgb(var(--warning) / 0.35)', background: 'rgb(var(--warning) / 0.08)' }}
        >
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" style={{ color: 'rgb(var(--warning))' }} />
          <p className="text-[11px] leading-snug text-dim">
            Часть отметок — <b className="text-[color:var(--text)]">примеры из демо-набора</b>, а не
            живые сообщения пользователей. Они помечены значком «пример». Ваши собственные отчёты
            реальны и сохраняются в вашем аккаунте.
          </p>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[1.5rem] border" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <EmptyState
            icon={<AlertOctagon className="w-5 h-5" />}
            title={regionFilter === 'all' ? 'Сообщений нет' : `По региону «${regionFilter}» отчётов нет`}
            text={
              regionFilter === 'all'
                ? 'Если у вас ограничения или белые списки — добавьте первый отчёт по своему региону.'
                : 'Это значит, что сбоев там пока никто не отмечал — а не то, что всё точно работает. Если у вас сейчас что-то не открывается, добавьте отчёт: регион уже подставим.'
            }
            action={
              <Button
                variant="soft"
                size="md"
                onClick={() => openCreate(regionFilter === 'all' ? undefined : regionFilter)}
              >
                {regionFilter === 'all' ? 'Добавить отчёт' : 'Сообщить о сбое здесь'}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((inc) => {
            const color = TYPE_COLOR[inc.incident_type] || 'rgb(var(--danger))';
            const resolved = inc.status === 'resolved';
            return (
              <article
                key={inc.client_id || inc.id}
                className="rounded-2xl border p-3"
                style={{
                  borderColor: 'var(--line)',
                  background: 'var(--surface)',
                  opacity: resolved ? 0.72 : 1,
                }}
              >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className="text-[9.5px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
                  >
                    {TYPE_LABEL[inc.incident_type] || 'Сбой'}
                  </span>
                  <span className="text-[10.5px] font-semibold text-dim inline-flex items-center gap-0.5">
                    <MapPin className="w-3 h-3" />
                    {inc.region}
                  </span>
                  <span className="text-[10.5px] font-semibold text-dim inline-flex items-center gap-0.5">
                    <Radio className="w-3 h-3" />
                    {inc.carrier}
                  </span>
                  {inc.demo && !resolved && (
                    <span
                      className="text-[9.5px] font-bold px-1.5 py-0.5 rounded ml-auto"
                      style={{ background: 'rgb(var(--warning) / 0.16)', color: 'rgb(var(--warning))' }}
                    >
                      пример
                    </span>
                  )}
                  {IS_DEMO_BUILD && !inc.demo && !resolved && (
                    <span
                      className="text-[9.5px] font-bold px-1.5 py-0.5 rounded ml-auto"
                      style={{
                        background: !isForeignEndpoint(inc) && inc.sync_state === 'synced' ? 'rgb(var(--success) / 0.14)' : 'var(--surface-2)',
                        color: isForeignEndpoint(inc) ? 'var(--text-muted)' : inc.sync_state === 'error' ? 'rgb(var(--danger))' : inc.sync_state === 'synced' ? 'rgb(var(--success))' : 'var(--text-muted)',
                      }}
                    >
                      {isForeignEndpoint(inc) ? 'другой сервер' : inc.pending_delete ? 'ждёт удаления' : inc.vote_dirty ? 'голос ждёт доставки' : inc.sync_state === 'synced' && !inc.sync_dirty ? 'доставлено' : inc.sync_state === 'error' ? 'не доставлено' : 'ждёт доставки'}
                    </span>
                  )}
                  {resolved && (
                    <span
                      className="text-[9.5px] font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-1 ml-auto"
                      style={{
                        background: 'rgb(var(--success) / 0.14)',
                        color: 'rgb(var(--success))',
                      }}
                    >
                      <CheckCircle2 className="w-3 h-3" />
                      восстановлено
                    </span>
                  )}
                </div>

                <h3 className="text-[13.5px] font-bold leading-snug mt-1.5">{inc.title}</h3>
                {inc.description && (
                  <p className="text-[11.5px] text-dim leading-relaxed mt-1 line-clamp-3">
                    {inc.description}
                  </p>
                )}
                {inc.sync_state === 'error' && inc.sync_error && (
                  <p className="text-[10.5px] leading-snug mt-1.5" style={{ color: 'rgb(var(--danger))' }}>
                    Не доставлено: {inc.sync_error}
                  </p>
                )}

                <div className="flex items-center gap-2 mt-2 text-[10px] text-muted flex-wrap">
                  <span>{inc.author_name}</span>
                  <span>·</span>
                  <span>
                    {new Date(inc.created_at).toLocaleString('ru-RU', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-[rgb(var(--success))]">
                    Рунет: {inc.ru_sites_ok ? 'да' : 'нет'}
                  </span>
                  <span className={inc.foreign_sites_ok ? 'text-[rgb(var(--success))]' : 'text-[rgb(var(--danger))]'}>
                    Зарубеж: {inc.foreign_sites_ok ? 'да' : 'нет'}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2.5 border-t" style={{ borderColor: 'var(--line)' }}>
                  {(!IS_DEMO_BUILD || communityUrl) && !isForeignEndpoint(inc) && (
                    <Button
                      variant={inc.user_upvoted ? 'soft' : 'outline'}
                      size="sm"
                      icon={<ThumbsUp className="w-3.5 h-3.5" />}
                      onClick={() => void handleToggleUpvote(inc)}
                    >
                      У меня так же · {inc.upvotes}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Share2 className="w-3.5 h-3.5" />}
                    onClick={() => void handleShare(inc)}
                  >
                    Поделиться
                  </Button>
                  {inc.is_owner && !isForeignEndpoint(inc) && (
                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => void handleToggleResolved(inc)}
                        title={resolved ? 'Вернуть в активные' : 'Отметить решённым'}
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--success))]"
                      >
                        {resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(inc)}
                        title="Изменить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--accent))]"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(inc)}
                        title="Удалить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--danger))]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmSheet
        open={pendingDelete !== null}
        title="Удалить отчёт?"
        text={
          pendingDelete
            ? `«${pendingDelete.title}» пропадёт из региональной сводки. Отменить это не получится.`
            : ''
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void handleDelete(target);
        }}
      />

      <Sheet
        open={placePickerOpen}
        onClose={() => {
          setPlacePickerOpen(false);
          setPlaceQuery('');
        }}
        title="Добавить место"
        subtitle="Найдите город или деревню по названию"
        size="md"
        footer={
          <Button variant="ghost" size="md" block onClick={() => setPlacePickerOpen(false)}>
            Закрыть
          </Button>
        }
      >
        <div className="space-y-3">
          <div
            className="flex items-center gap-2 rounded-xl border px-3"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
          >
            <Search className="w-3.5 h-3.5 text-muted shrink-0" />
            <input
              type="text"
              value={placeQuery}
              onChange={(e) => setPlaceQuery(e.target.value)}
              placeholder="Например: Жижица"
              className="flex-1 bg-transparent outline-none py-2 text-[12.5px]"
              style={{ color: 'var(--text)' }}
            />
            {placeQuery && (
              <button
                type="button"
                onClick={() => setPlaceQuery('')}
                aria-label="Очистить"
                className="p-1 text-muted"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            {searchPlaces(placeQuery).map((place) => {
              const added = favorites.some((f) => f.id === place.id);
              return (
                <button
                  key={place.id}
                  type="button"
                  disabled={added}
                  onClick={() => addPlace(place)}
                  className="w-full flex items-center gap-2 rounded-xl px-2.5 py-2 text-left tap disabled:opacity-50"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold truncate">{place.name}</span>
                    <span className="block text-[10.5px] text-dim truncate">{place.region}</span>
                  </span>
                  <span
                    className="text-[11px] font-semibold shrink-0"
                    style={{ color: added ? 'var(--text-muted)' : 'rgb(var(--accent))' }}
                  >
                    {added ? 'уже есть' : 'добавить'}
                  </span>
                </button>
              );
            })}
            {searchPlaces(placeQuery).length === 0 && (
              <div className="space-y-2">
                <p className="text-[11.5px] text-dim leading-snug px-1">
                  Такого места в списке нет — но его можно добавить вручную.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={placeQuery || 'Название места'}
                    className="flex-1 px-3 py-2 rounded-xl text-[12.5px] outline-none"
                    style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => {
                      const raw = (customName || placeQuery).trim();
                      if (raw.length < 2) return;
                      // Первая буква заглавная — иначе в списке висит «заозерье».
                      const name = raw.charAt(0).toUpperCase() + raw.slice(1);
                      addPlace({
                        id: placeKey(name, user.region || 'Мой регион'),
                        name,
                        region: user.region || 'Мой регион',
                      });
                      setCustomName('');
                    }}
                  >
                    Добавить
                  </Button>
                </div>
                <p className="text-[10.5px] text-muted leading-snug px-1">
                  Регион возьмём из вашего профиля — его можно поменять в настройках.
                </p>
              </div>
            )}
          </div>

          <p className="text-[10.5px] text-muted leading-snug flex gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            Список мест небольшой и составлен вручную. Координаты есть только у тех точек, где они
            действительно известны — карта по пустым данным не рисуется.
          </p>
        </div>
      </Sheet>

      <Sheet
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Изменить отчёт' : 'Сообщить о сбое'}
        subtitle="Чем точнее детали, тем полезнее сводка"
        size="md"
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
              icon={<Check className="w-4 h-4" />}
              onClick={() =>
                (document.getElementById('incident-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              {editing ? 'Сохранить' : IS_DEMO_BUILD && !communityUrl ? 'Сохранить отчёт' : 'Опубликовать'}
            </Button>
          </>
        }
      >
        <form id="incident-form" onSubmit={handleSave} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Регион</span>
              <select value={region} onChange={(e) => setRegion(e.target.value)} className={input} style={inputStyle}>
                {RUSSIAN_REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Оператор</span>
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)} className={input} style={inputStyle}>
                {RUSSIAN_CARRIERS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Тип ограничений</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(TYPE_LABEL) as Incident['incident_type'][]).map((t) => (
                <Chip key={t} active={incidentType === t} onClick={() => setIncidentType(t)}>
                  {TYPE_LABEL[t]}
                </Chip>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Заголовок</span>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: на МТС работают только ВК и Госуслуги"
              className={input}
              style={inputStyle}
            />
          </label>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Подробности</span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Что именно не работает: мобильные данные, домашний Wi-Fi, подключается ли VPN"
              className={input}
              style={inputStyle}
            />
          </label>

          {!editing && (
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Сайты РФ открываются', checked: ruSitesOk, set: setRuSitesOk },
                { label: 'Зарубежные открываются', checked: foreignSitesOk, set: setForeignSitesOk },
              ].map((f) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => f.set(!f.checked)}
                  className="flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[11px]"
                  style={{
                    borderColor: f.checked ? 'rgb(var(--accent) / 0.45)' : 'var(--line)',
                    background: f.checked ? 'rgb(var(--accent) / 0.1)' : 'var(--surface-2)',
                  }}
                >
                  <span
                    className="w-4 h-4 rounded grid place-items-center shrink-0"
                    style={{
                      background: f.checked ? 'rgb(var(--accent))' : 'transparent',
                      border: f.checked ? 'none' : '1px solid var(--line-strong)',
                    }}
                  >
                    {f.checked && <Check className="w-3 h-3 text-[color:var(--accent-ink)]" />}
                  </span>
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {editing && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Статус</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Incident['status'])}
                  className={input}
                  style={inputStyle}
                >
                  <option value="active">Активен</option>
                  <option value="resolved">Восстановлено</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Важность</span>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as Incident['severity'])}
                  className={input}
                  style={inputStyle}
                >
                  <option value="critical">Критично</option>
                  <option value="high">Заметно</option>
                  <option value="moderate">Слабо</option>
                </select>
              </label>
            </div>
          )}
        </form>
      </Sheet>

      <Sheet
        open={communitySettingsOpen}
        onClose={() => setCommunitySettingsOpen(false)}
        title="Общий сервер сбоев"
        subtitle="Доставка отчётов владельцу и другим пользователям"
        size="sm"
        icon={<Cloud className="w-5 h-5" style={{ color: 'rgb(var(--accent))' }} />}
        footer={
          <>
            {communityDraft && <Button variant="ghost" block onClick={() => setCommunityDraft('')}>Отключить сервер</Button>}
            <Button variant="primary" block loading={connecting} onClick={() => void saveCommunitySettings()}>Проверить и подключить</Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">HTTPS-адрес развёрнутого сервера</span>
            <input
              value={communityDraft}
              onChange={(event) => setCommunityDraft(event.target.value)}
              placeholder="https://pulsenet-api.example.com"
              className={`${input} font-mono`}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          <p className="text-[11px] leading-relaxed text-dim">
            Используется сервер из этого репозитория с endpoint <span className="font-mono">/api/community/incidents</span>.
            Один и тот же адрес должен быть задан у владельца и пользователей. Адрес можно также задать
            переменной сборки <span className="font-mono">VITE_COMMUNITY_API_URL</span>.
          </p>
          <div className="rounded-xl border p-3 text-[11px] leading-relaxed text-dim" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
            Отправляются только регион, оператор, текст отчёта и технический ID устройства. Внешний IP,
            VPN-конфиги и подтверждения приложений на общий сервер не передаются. Повторная синхронизация
            не создаёт дубли; свои отчёты может изменить только то же устройство.
          </div>
        </div>
      </Sheet>
    </div>
  );
};
