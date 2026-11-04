import React, { useState } from 'react';
import {
  Plus,
  Search,
  Globe,
  Zap,
  Pencil,
  Trash2,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Clock,
  HelpCircle,
  X,
  Loader2,
} from 'lucide-react';
import {
  CATEGORY_META,
  type MarkerRole,
  type Site,
  type SiteCategory,
} from '../types';
import { apiFetch } from '../lib/api';
import { probeSingleSite } from '../lib/scanner';

interface SitesViewProps {
  sites: Site[];
  setSites: React.Dispatch<React.SetStateAction<Site[]>>;
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

export const SitesView: React.FC<SitesViewProps> = ({
  sites,
  setSites,
  darkMode,
  showToast,
}) => {
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<'all' | SiteCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'blocked' | 'disabled'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'whitelist' | 'neutral' | 'rkn'>('all');
  const [pingingId, setPingingId] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);

  // Add / Edit Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [formName, setFormName] = useState('');
  const [formDomain, setFormDomain] = useState('');
  const [formProbeUrl, setFormProbeUrl] = useState('');
  const [formCategory, setFormCategory] = useState<SiteCategory>('custom');
  const [formMarkerRole, setFormMarkerRole] = useState<MarkerRole>('global_neutral');
  const [formDesc, setFormDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const openCreateModal = () => {
    setEditingSite(null);
    setFormName('');
    setFormDomain('');
    setFormProbeUrl('');
    setFormCategory('custom');
    setFormMarkerRole('global_neutral');
    setFormDesc('');
    setModalOpen(true);
  };

  const openEditModal = (site: Site) => {
    setEditingSite(site);
    setFormName(site.name);
    setFormDomain(site.domain);
    setFormProbeUrl(site.probe_url);
    setFormCategory(site.category);
    setFormMarkerRole(site.marker_role);
    setFormDesc(site.description || '');
    setModalOpen(true);
  };

  const handleSaveSite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingSite) {
        const res = await apiFetch<{ site: Site }>(`/api/sites/${editingSite.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: formName,
            domain: formDomain,
            probe_url: formProbeUrl || undefined,
            category: formCategory,
            marker_role: formMarkerRole,
            description: formDesc,
          }),
        });
        setSites((prev) => prev.map((s) => (s.id === editingSite.id ? res.site : s)));
        showToast('success', `Сайт «${res.site.name}» обновлён`);
      } else {
        const res = await apiFetch<{ site: Site }>('/api/sites', {
          method: 'POST',
          body: JSON.stringify({
            name: formName,
            domain: formDomain,
            probe_url: formProbeUrl || undefined,
            category: formCategory,
            marker_role: formMarkerRole,
            description: formDesc,
          }),
        });
        setSites((prev) => [res.site, ...prev]);
        showToast('success', `Сайт «${res.site.name}» добавлен в список проверки`);
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения сайта');
    } finally {
      setSaving(false);
    }
  };

  // Optimistic toggle enabled
  const handleToggleEnabled = async (site: Site) => {
    const nextEnabled = !Boolean(site.enabled);
    setSites((prev) =>
      prev.map((s) => (s.id === site.id ? { ...s, enabled: nextEnabled } : s))
    );
    try {
      await apiFetch(`/api/sites/${site.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: nextEnabled }),
      });
    } catch {
      setSites((prev) =>
        prev.map((s) => (s.id === site.id ? { ...s, enabled: site.enabled } : s))
      );
      showToast('error', 'Не удалось изменить статус активности сайта');
    }
  };

  // Optimistic delete
  const handleDeleteSite = async (site: Site) => {
    const backup = sites;
    setSites((prev) => prev.filter((s) => s.id !== site.id));
    try {
      await apiFetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      showToast('info', `Сайт «${site.name}» удалён`);
    } catch {
      setSites(backup);
      showToast('error', 'Не удалось удалить сайт');
    }
  };

  // Instant single-site live probe
  const handlePingSingleSite = async (site: Site) => {
    setPingingId(site.id);
    try {
      const result = await probeSingleSite(site, 'live');
      const checkedAt = new Date().toISOString();
      setSites((prev) =>
        prev.map((s) =>
          s.id === site.id
            ? {
                ...s,
                last_status: result.status,
                last_latency_ms: result.latency_ms,
                last_checked_at: checkedAt,
              }
            : s
        )
      );
      await apiFetch(`/api/sites/${site.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          last_status: result.status,
          last_latency_ms: result.latency_ms,
          last_checked_at: checkedAt,
        }),
      });
      if (result.status === 'ok' || result.status === 'slow') {
        showToast('success', `${site.name}: доступен (${result.latency_ms} мс)`);
      } else {
        showToast('warning', `${site.name}: недоступен / таймаут`);
      }
    } finally {
      setPingingId(null);
    }
  };

  const handleResetDefaults = async () => {
    setResetting(true);
    try {
      const res = await apiFetch<{ sites: Site[] }>('/api/sites/reset', {
        method: 'POST',
      });
      setSites(res.sites);
      showToast('success', `Восстановлен полный набор из ${res.sites.length} сайтов`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сброса каталога');
    } finally {
      setResetting(false);
    }
  };

  const roleOf = (site: Site): 'whitelist' | 'neutral' | 'rkn' => {
    if (site.marker_role === 'ru_whitelist' || site.category === 'ru_whitelist') return 'whitelist';
    if (site.marker_role === 'dpi_target') return 'rkn';
    return 'neutral';
  };

  const filteredSites = sites.filter((s) => {
    if (roleFilter !== 'all' && roleOf(s) !== roleFilter) return false;
    if (catFilter !== 'all' && s.category !== catFilter) return false;
    if (statusFilter === 'ok' && s.last_status !== 'ok' && s.last_status !== 'slow') return false;
    if (statusFilter === 'blocked' && s.last_status !== 'blocked') return false;
    if (statusFilter === 'disabled' && Boolean(s.enabled)) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.domain.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const enabledCount = sites.filter((s) => Boolean(s.enabled)).length;
  const roleCounts = {
    whitelist: sites.filter((s) => roleOf(s) === 'whitelist').length,
    neutral: sites.filter((s) => roleOf(s) === 'neutral').length,
    rkn: sites.filter((s) => roleOf(s) === 'rkn').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Каталог проверяемых сайтов</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Активно {enabledCount} из {sites.length} ресурсов: белый список Минцифры (
            {roleCounts.whitelist}), нейтральные ({roleCounts.neutral}) и заблокированные РКН (
            {roleCounts.rkn}). Статусы сверены на ноябрь 2026.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetDefaults}
            disabled={resetting}
            className={`px-3.5 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              darkMode
                ? 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            {resetting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
            База 75 сайтов
          </button>

          <button
            type="button"
            onClick={openCreateModal}
            className="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-lg shadow-sky-500/20"
          >
            <Plus className="w-4 h-4" />
            Добавить сайт
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div
        className={`p-4 rounded-2xl border space-y-3 ${
          darkMode ? 'bg-slate-900/70 border-slate-800/80' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию или домену (например: youtube, госуслуги, steam, cloudflare)..."
              className={`w-full pl-10 pr-4 py-2.5 rounded-xl border text-sm ${
                darkMode
                  ? 'bg-slate-950 border-slate-800 text-white placeholder:text-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className={`px-3.5 py-2.5 rounded-xl border text-xs sm:text-sm font-medium ${
              darkMode
                ? 'bg-slate-950 border-slate-800 text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <option value="all">Все статусы</option>
            <option value="ok">Доступны при последней проверке</option>
            <option value="blocked">Заблокированы / Таймаут</option>
            <option value="disabled">Отключённые мной</option>
          </select>
        </div>

        {/* Статус ресурса: белый список / не заблокирован / заблокирован РКН */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            {
              key: 'whitelist' as const,
              title: '🇷🇺 Белый список РФ',
              hint: 'Перечень Минцифры — работает при отключениях',
              count: roleCounts.whitelist,
              tone: 'border-sky-500/40 text-sky-300 bg-sky-500/10',
            },
            {
              key: 'neutral' as const,
              title: '🌐 Не заблокированы',
              hint: 'Нейтральные сайты — должны открываться всегда',
              count: roleCounts.neutral,
              tone: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
            },
            {
              key: 'rkn' as const,
              title: '🚫 Заблокированы РКН',
              hint: 'Нужен VPN, падение не значит белый список',
              count: roleCounts.rkn,
              tone: 'border-rose-500/40 text-rose-300 bg-rose-500/10',
            },
          ].map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setRoleFilter(roleFilter === chip.key ? 'all' : chip.key)}
              className={`text-left p-2.5 rounded-xl border transition-all ${
                roleFilter === chip.key
                  ? chip.tone
                  : darkMode
                  ? 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700'
                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold truncate">{chip.title}</span>
                <span className="text-xs font-mono font-black">{chip.count}</span>
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">{chip.hint}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setCatFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap border ${
              catFilter === 'all'
                ? 'bg-sky-500 text-slate-950 border-sky-400'
                : darkMode
                ? 'bg-slate-950 border-slate-800 text-slate-400'
                : 'bg-slate-100 border-slate-200 text-slate-600'
            }`}
          >
            Все категории ({sites.length})
          </button>
          {(Object.keys(CATEGORY_META) as SiteCategory[]).map((cat) => {
            const cnt = sites.filter((s) => s.category === cat).length;
            if (cnt === 0 && cat === 'custom') return null;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCatFilter(cat)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap border ${
                  catFilter === cat
                    ? 'bg-sky-500 text-slate-950 border-sky-400'
                    : darkMode
                    ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-slate-100 border-slate-200 text-slate-600'
                }`}
              >
                {CATEGORY_META[cat].shortLabel} ({cnt})
              </button>
            );
          })}
        </div>
      </div>

      {/* Empty State */}
      {filteredSites.length === 0 ? (
        <div
          className={`rounded-3xl border p-10 text-center ${
            darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <Globe className="w-12 h-12 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold">Сайты не найдены</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            {sites.length === 0
              ? 'Ваш список проверяемых сайтов пуст. Добавьте свой сайт или восстановите базовый набор из 75 ресурсов.'
              : 'По выбранным фильтрам ничего не найдено. Попробуйте сбросить поиск или сменить категорию.'}
          </p>
          <div className="flex justify-center gap-3 mt-5">
            {sites.length === 0 ? (
              <button
                type="button"
                onClick={handleResetDefaults}
                className="px-4 py-2.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-sm"
              >
                Загрузить 75 стандартных сайтов
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setCatFilter('all');
                  setStatusFilter('all');
                }}
                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold"
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredSites.map((site) => {
            const catMeta = CATEGORY_META[site.category] || CATEGORY_META.custom;
            const isEnabled = Boolean(site.enabled);
            return (
              <div
                key={site.id}
                className={`p-4 rounded-2xl border flex flex-col justify-between gap-3 transition-all ${
                  !isEnabled
                    ? darkMode
                      ? 'bg-slate-950/40 border-slate-900 opacity-60'
                      : 'bg-slate-100/60 border-slate-200 opacity-60'
                    : darkMode
                    ? 'bg-slate-900/70 border-slate-800/90 hover:border-slate-700'
                    : 'bg-white border-slate-200 shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm truncate">{site.name}</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${catMeta.badgeColor}`}
                      >
                        {catMeta.shortLabel}
                      </span>
                    </div>
                    <div className="font-mono text-xs text-sky-400 mt-0.5 truncate">
                      {site.domain}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {roleOf(site) === 'whitelist' && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                          белый список Минцифры
                        </span>
                      )}
                      {roleOf(site) === 'neutral' && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          не заблокирован в РФ
                        </span>
                      )}
                      {roleOf(site) === 'rkn' && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30"
                          title={site.description}
                        >
                          заблокирован РКН
                          {site.blocked_since ? ` • с ${site.blocked_since}` : ''}
                        </span>
                      )}
                      {site.accessibility === 'restricted' && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          работает с ограничениями
                        </span>
                      )}
                    </div>
                    {site.description && (
                      <p className="text-xs text-slate-400 mt-1 line-clamp-2">
                        {site.description}
                      </p>
                    )}
                  </div>

                  {/* Toggle Switch */}
                  <button
                    type="button"
                    onClick={() => handleToggleEnabled(site)}
                    title={isEnabled ? 'Участвует в проверке' : 'Отключён'}
                    className={`w-11 h-6 rounded-full p-0.5 transition-colors shrink-0 ${
                      isEnabled ? 'bg-sky-500' : 'bg-slate-700'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full bg-white transition-transform ${
                        isEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="pt-2.5 border-t border-slate-800/40 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    {site.last_status === 'ok' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-400 font-semibold">
                          Доступен ({site.last_latency_ms} мс)
                        </span>
                      </>
                    ) : site.last_status === 'slow' ? (
                      <>
                        <Clock className="w-4 h-4 text-amber-400" />
                        <span className="text-amber-400 font-semibold">
                          Медленно ({site.last_latency_ms} мс)
                        </span>
                      </>
                    ) : site.last_status === 'blocked' ? (
                      <>
                        <XCircle className="w-4 h-4 text-rose-400" />
                        <span className="text-rose-400 font-semibold">Недоступен</span>
                      </>
                    ) : (
                      <>
                        <HelpCircle className="w-4 h-4 text-slate-500" />
                        <span className="text-slate-500">Ещё не проверялся</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={pingingId === site.id}
                      onClick={() => handlePingSingleSite(site)}
                      title="Пропинговать прямо сейчас"
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border flex items-center gap-1 transition-colors ${
                        darkMode
                          ? 'border-slate-800 bg-slate-950 hover:border-sky-500/50 text-sky-400'
                          : 'border-slate-200 bg-slate-50 hover:bg-sky-50 text-sky-600'
                      }`}
                    >
                      {pingingId === site.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Zap className="w-3.5 h-3.5" />
                      )}
                      Пинг
                    </button>

                    <button
                      type="button"
                      onClick={() => openEditModal(site)}
                      title="Редактировать"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeleteSite(site)}
                      title="Удалить"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
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

      {/* ==================== ADD / EDIT SITE MODAL ==================== */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">
                {editingSite ? 'Редактировать ресурс' : 'Добавить сайт для проверки'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveSite} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Название сервиса *</label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Например: Хабр или Мой VPS"
                    className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">Домен или хост *</label>
                  <input
                    type="text"
                    required
                    value={formDomain}
                    onChange={(e) => setFormDomain(e.target.value)}
                    placeholder="habr.com"
                    className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-mono ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  URL для HTTPS-проверки (необязательно — создастся автоматически)
                </label>
                <input
                  type="url"
                  value={formProbeUrl}
                  onChange={(e) => setFormProbeUrl(e.target.value)}
                  placeholder="https://habr.com/favicon.ico"
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-mono ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Категория</label>
                  <select
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value as SiteCategory)}
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  >
                    {(Object.keys(CATEGORY_META) as SiteCategory[]).map((cat) => (
                      <option key={cat} value={cat}>
                        {CATEGORY_META[cat].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Диагностическая роль
                  </label>
                  <select
                    value={formMarkerRole}
                    onChange={(e) => setFormMarkerRole(e.target.value as MarkerRole)}
                    className={`w-full px-3 py-2.5 rounded-xl border text-sm ${
                      darkMode
                        ? 'bg-slate-950 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-300 text-slate-900'
                    }`}
                  >
                    <option value="global_neutral">Глобальный нейтральный (маркер БС)</option>
                    <option value="ru_whitelist">Белый список РФ / Рунет</option>
                    <option value="dpi_target">Под фильтрацией ТСПУ / РКН</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Описание / Заметка</label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  placeholder="Краткое описание узла"
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
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
                  {saving ? 'Сохранение...' : editingSite ? 'Сохранить' : 'Добавить сайт'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
