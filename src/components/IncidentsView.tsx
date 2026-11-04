import React, { useEffect, useState } from 'react';
import {
  AlertOctagon,
  Plus,
  ThumbsUp,
  CheckCircle2,
  MapPin,
  Radio,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  RUSSIAN_CARRIERS,
  RUSSIAN_REGIONS,
  type Incident,
  type ScanRecord,
  type User,
} from '../types';
import { apiFetch } from '../lib/api';

interface IncidentsViewProps {
  user: User;
  incidents: Incident[];
  setIncidents: React.Dispatch<React.SetStateAction<Incident[]>>;
  prefillFromScan: ScanRecord | null;
  onClearPrefill: () => void;
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const INCIDENT_TYPES: Record<
  Incident['incident_type'],
  { label: string; color: string }
> = {
  whitelist: {
    label: 'Белые списки (доступен только Рунет)',
    color: 'bg-rose-500/15 text-rose-400 border-rose-500/35',
  },
  mobile_shutdown: {
    label: 'Шатдаун / Глушение мобильного 4G',
    color: 'bg-red-500/15 text-red-400 border-red-500/35',
  },
  cdn_block: {
    label: 'Блок подсетей Cloudflare / AWS / Hetzner',
    color: 'bg-orange-500/15 text-orange-400 border-orange-500/35',
  },
  vpn_block: {
    label: 'Блокировка протоколов VPN на ТСПУ',
    color: 'bg-amber-500/15 text-amber-400 border-amber-500/35',
  },
  dpi_wave: {
    label: 'Волна замедления ТСПУ / DPI',
    color: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/35',
  },
};

export const IncidentsView: React.FC<IncidentsViewProps> = ({
  user,
  incidents,
  setIncidents,
  prefillFromScan,
  onClearPrefill,
  darkMode,
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

  // Open prefilled modal if user tapped "Сообщить о сбое в регионе" from Scanner Verdict
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
          ? `Включены белые списки (${user.carrier})`
          : isJamming
          ? `Глушение мобильного интернета (${user.carrier})`
          : `Массовая недоступность зарубежных сайтов (${user.carrier})`
      );
      setDescription(
        `По результатам замера ПульсСети: сайты РФ — ${prefillFromScan.ru_ok_pct}%, глобальные CDN — ${prefillFromScan.global_ok_pct}%, доступно ${prefillFromScan.ok_sites + prefillFromScan.slow_sites} из ${prefillFromScan.total_sites} узлов.`
      );
      setRuSitesOk(prefillFromScan.ru_ok_pct >= 50);
      setForeignSitesOk(prefillFromScan.global_ok_pct >= 50);
      setModalOpen(true);
      onClearPrefill();
    }
  }, [prefillFromScan, user.region, user.carrier, onClearPrefill]);

  const openCreate = () => {
    setEditing(null);
    setRegion(user.region || 'Москва и МО');
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
        const res = await apiFetch<{ incident: Incident }>(`/api/incidents/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            region,
            carrier,
            incident_type: incidentType,
            severity,
            status,
            title,
            description,
          }),
        });
        setIncidents((prev) => prev.map((x) => (x.id === editing.id ? res.incident : x)));
        showToast('success', 'Отчёт о ситуации в регионе обновлён');
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
          }),
        });
        setIncidents((prev) => [res.incident, ...prev]);
        showToast('success', 'Ваш отчёт опубликован в региональной сводке!');
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения отчёта');
    } finally {
      setSaving(false);
    }
  };

  // Optimistic Upvote ("У меня так же")
  const handleToggleUpvote = async (inc: Incident) => {
    const nextVoted = !inc.user_upvoted;
    const nextCount = Math.max(0, inc.upvotes + (nextVoted ? 1 : -1));
    setIncidents((prev) =>
      prev.map((x) =>
        x.id === inc.id ? { ...x, user_upvoted: nextVoted, upvotes: nextCount } : x
      )
    );
    try {
      const res = await apiFetch<{ incident: Incident }>(`/api/incidents/${inc.id}/upvote`, {
        method: 'POST',
      });
      setIncidents((prev) => prev.map((x) => (x.id === inc.id ? res.incident : x)));
    } catch {
      setIncidents((prev) => prev.map((x) => (x.id === inc.id ? inc : x)));
      showToast('error', 'Не удалось обновить подтверждение');
    }
  };

  const handleToggleResolved = async (inc: Incident) => {
    const nextStatus: Incident['status'] = inc.status === 'active' ? 'resolved' : 'active';
    setIncidents((prev) =>
      prev.map((x) => (x.id === inc.id ? { ...x, status: nextStatus } : x))
    );
    try {
      await apiFetch(`/api/incidents/${inc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      showToast(
        'success',
        nextStatus === 'resolved' ? 'Отмечено: связь восстановлена' : 'Отчёт снова активен'
      );
    } catch {
      setIncidents((prev) => prev.map((x) => (x.id === inc.id ? inc : x)));
      showToast('error', 'Ошибка смены статуса');
    }
  };

  const handleDelete = async (inc: Incident) => {
    const backup = incidents;
    setIncidents((prev) => prev.filter((x) => x.id !== inc.id));
    try {
      await apiFetch(`/api/incidents/${inc.id}`, { method: 'DELETE' });
      showToast('info', 'Отчёт удалён');
    } catch {
      setIncidents(backup);
      showToast('error', 'Не удалось удалить отчёт');
    }
  };

  const activeList = incidents.filter((i) => i.status === 'active');
  const whitelistRegionsCount = new Set(
    activeList.filter((i) => i.incident_type === 'whitelist').map((i) => i.region)
  ).size;
  const shutdownRegionsCount = new Set(
    activeList.filter((i) => i.incident_type === 'mobile_shutdown').map((i) => i.region)
  ).size;

  const filtered = incidents.filter((inc) => {
    if (regionFilter !== 'all' && inc.region !== regionFilter) return false;
    if (carrierFilter !== 'all' && inc.carrier !== carrierFilter) return false;
    if (statusFilter !== 'all' && inc.status !== statusFilter) return false;
    return true;
  });

  const uniqueRegionsInFeed = Array.from(new Set(incidents.map((i) => i.region)));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">
            Сводка шатдаунов и «белых списков» по РФ
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Оперативный мониторинг регионов, где сейчас глушат мобильный интернет или ввели белые
            списки
          </p>
        </div>

        <button
          type="button"
          onClick={openCreate}
          className="px-4 py-2.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-lg shadow-rose-500/20 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Сообщить о сбое
        </button>
      </div>

      {/* Summary Telemetry Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div
          className={`p-4 rounded-2xl border ${
            darkMode ? 'bg-rose-950/30 border-rose-500/30' : 'bg-rose-50 border-rose-200'
          }`}
        >
          <div className="text-xs text-rose-400 font-bold uppercase tracking-wider">
            Режим Белых списков
          </div>
          <div className="text-2xl font-black font-mono mt-1">{whitelistRegionsCount} рег.</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Открываются только сервисы РФ, внешний трафик отрезан
          </div>
        </div>

        <div
          className={`p-4 rounded-2xl border ${
            darkMode ? 'bg-amber-950/30 border-amber-500/30' : 'bg-amber-50 border-amber-200'
          }`}
        >
          <div className="text-xs text-amber-400 font-bold uppercase tracking-wider">
            Шатдаун мобильной сети
          </div>
          <div className="text-2xl font-black font-mono mt-1">{shutdownRegionsCount} рег.</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Отключение 4G/LTE или сброс базовых станций в 2G EDGE
          </div>
        </div>

        <div
          className={`p-4 rounded-2xl border ${
            darkMode ? 'bg-slate-900/70 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className="text-xs text-sky-400 font-bold uppercase tracking-wider">
            Подтверждений за сутки
          </div>
          <div className="text-2xl font-black font-mono mt-1">
            {incidents.reduce((sum, i) => sum + i.upvotes, 0)}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            Всего активных инцидентов: {activeList.length}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div
        className={`p-3.5 rounded-2xl border flex flex-wrap items-center gap-3 ${
          darkMode ? 'bg-slate-900/70 border-slate-800/80' : 'bg-white border-slate-200'
        }`}
      >
        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-xs sm:text-sm ${
            darkMode
              ? 'bg-slate-950 border-slate-800 text-slate-200'
              : 'bg-slate-50 border-slate-200 text-slate-800'
          }`}
        >
          <option value="all">Все регионы ({incidents.length})</option>
          {uniqueRegionsInFeed.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <select
          value={carrierFilter}
          onChange={(e) => setCarrierFilter(e.target.value)}
          className={`px-3 py-2 rounded-xl border text-xs sm:text-sm ${
            darkMode
              ? 'bg-slate-950 border-slate-800 text-slate-200'
              : 'bg-slate-50 border-slate-200 text-slate-800'
          }`}
        >
          <option value="all">Все операторы</option>
          {RUSSIAN_CARRIERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1 ml-auto">
          {(['all', 'active', 'resolved'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
                statusFilter === st
                  ? 'bg-sky-500 text-slate-950 border-sky-400'
                  : darkMode
                  ? 'bg-slate-950 border-slate-800 text-slate-400'
                  : 'bg-slate-100 border-slate-200 text-slate-600'
              }`}
            >
              {st === 'all' ? 'Все' : st === 'active' ? 'Активные' : 'Устранённые'}
            </button>
          ))}
        </div>
      </div>

      {/* Incident Cards */}
      {filtered.length === 0 ? (
        <div
          className={`rounded-3xl border p-10 text-center ${
            darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <AlertOctagon className="w-12 h-12 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold">Сбоев по выбранным фильтрам нет</h3>
          <p className="text-sm text-slate-400 mt-1">
            Если у вас наблюдаются ограничения или белые списки — добавьте первый отчёт для вашего
            региона.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((inc) => {
            const typeMeta = INCIDENT_TYPES[inc.incident_type] || INCIDENT_TYPES.whitelist;
            return (
              <div
                key={inc.id}
                className={`rounded-2xl border p-5 transition-all ${
                  inc.status === 'resolved'
                    ? darkMode
                      ? 'bg-slate-900/35 border-slate-800/60 opacity-75'
                      : 'bg-slate-50 border-slate-200 opacity-80'
                    : darkMode
                    ? 'bg-slate-900/80 border-slate-800/90'
                    : 'bg-white border-slate-200 shadow-sm'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${typeMeta.color}`}
                      >
                        {typeMeta.label}
                      </span>

                      <span className="inline-flex items-center gap-1 text-xs font-bold text-sky-400">
                        <MapPin className="w-3.5 h-3.5" />
                        {inc.region}
                      </span>

                      <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-lg bg-slate-800 text-slate-200">
                        <Radio className="w-3 h-3 text-cyan-400" />
                        {inc.carrier}
                      </span>

                      {inc.status === 'resolved' && (
                        <span className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Восстановлено
                        </span>
                      )}
                    </div>

                    <h3 className="text-base sm:text-lg font-bold">{inc.title}</h3>
                    <p className="text-xs sm:text-sm text-slate-400 leading-relaxed max-w-3xl">
                      {inc.description}
                    </p>

                    <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-slate-500">
                      <span>Автор: {inc.author_name}</span>
                      <span>•</span>
                      <span>
                        {new Date(inc.created_at).toLocaleString('ru-RU', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span>•</span>
                      <span className={inc.ru_sites_ok ? 'text-emerald-400' : 'text-rose-400'}>
                        Рунет: {inc.ru_sites_ok ? 'работает' : 'лежит'}
                      </span>
                      <span className={inc.foreign_sites_ok ? 'text-emerald-400' : 'text-rose-400'}>
                        Зарубеж: {inc.foreign_sites_ok ? 'работает' : 'недоступен'}
                      </span>
                    </div>
                  </div>

                  {/* Upvote & Owner Controls */}
                  <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleUpvote(inc)}
                      className={`px-3.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-2 transition-all active:scale-95 ${
                        inc.user_upvoted
                          ? 'bg-sky-500/20 border-sky-400/50 text-sky-300'
                          : darkMode
                          ? 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                          : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      <ThumbsUp className="w-3.5 h-3.5" />
                      <span>У меня так же</span>
                      <span className="font-mono px-1.5 py-0.5 rounded-md bg-black/20">
                        {inc.upvotes}
                      </span>
                    </button>

                    {inc.is_owner && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggleResolved(inc)}
                          className="px-2 py-1 rounded-lg text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/10"
                        >
                          {inc.status === 'active' ? 'Решено' : 'В активные'}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(inc)}
                          className="p-1.5 text-slate-400 hover:text-sky-400"
                          title="Редактировать"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(inc)}
                          className="p-1.5 text-slate-400 hover:text-rose-400"
                          title="Удалить"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ==================== CREATE / EDIT INCIDENT MODAL ==================== */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl my-8 ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">
                {editing ? 'Редактировать отчёт' : 'Сообщить о белых списках / глушении'}
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
                  <label className="block text-xs text-slate-400 mb-1">Регион РФ</label>
                  <select
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  >
                    {RUSSIAN_REGIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Оператор связи</label>
                  <select
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  >
                    {RUSSIAN_CARRIERS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Тип ограничений</label>
                <select
                  value={incidentType}
                  onChange={(e) =>
                    setIncidentType(e.target.value as Incident['incident_type'])
                  }
                  className={`w-full px-3 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                >
                  <option value="whitelist">Включены белые списки (работает только РФ)</option>
                  <option value="mobile_shutdown">Полное глушение / отключение мобильного 4G</option>
                  <option value="cdn_block">Блокировка Cloudflare / AWS / зарубежных подсетей</option>
                  <option value="vpn_block">Блокировка протоколов VPN (WG / OpenVPN)</option>
                  <option value="dpi_wave">Усиление фильтрации ТСПУ / замедление видео</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Краткий заголовок *</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Напр.: На МТС работают только ВК, Яндекс и Госуслуги"
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Подробности</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Опишите симптомы: работает ли проводной Wi-Fi, какие сайты открываются, подключается ли VPN..."
                  className={`w-full px-3.5 py-2 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>

              {!editing && (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ruSitesOk}
                      onChange={(e) => setRuSitesOk(e.target.checked)}
                    />
                    <span>Сайты РФ открываются</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={foreignSitesOk}
                      onChange={(e) => setForeignSitesOk(e.target.checked)}
                    />
                    <span>Зарубежные сайты работают</span>
                  </label>
                </div>
              )}

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
                  className="px-5 py-2.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white font-bold text-sm"
                >
                  {saving ? 'Отправка...' : editing ? 'Сохранить' : 'Опубликовать отчёт'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
