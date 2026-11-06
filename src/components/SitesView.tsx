import React, { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Globe,
  Zap,
  Pencil,
  Trash2,
  RotateCcw,
  HelpCircle,
  Check,
} from 'lucide-react';
import {
  CATEGORY_META,
  type MarkerRole,
  type Site,
  type SiteCategory,
} from '../types';
import { apiFetch } from '../lib/api';
import { probeSingleSite } from '../lib/scanner';
import { Sheet } from './ui/Sheet';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { Button, Chip, EmptyState, StatusIcon } from './ui/kit';

interface SitesViewProps {
  sites: Site[];
  setSites: React.Dispatch<React.SetStateAction<Site[]>>;
  /** Больше не используется: цвета берутся из CSS-переменных. Оставлен для совместимости вызова. */
  darkMode?: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

export const SitesView: React.FC<SitesViewProps> = ({ sites, setSites, darkMode, showToast }) => {
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<'all' | SiteCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'blocked' | 'disabled'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'whitelist' | 'neutral' | 'rkn'>('all');
  const [pingingId, setPingingId] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [formName, setFormName] = useState('');
  const [formDomain, setFormDomain] = useState('');
  const [formProbeUrl, setFormProbeUrl] = useState('');
  const [formCategory, setFormCategory] = useState<SiteCategory>('custom');
  const [formMarkerRole, setFormMarkerRole] = useState<MarkerRole>('global_neutral');
  const [formDesc, setFormDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Site | null>(null);

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3 py-2.5 rounded-xl text-[13px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

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
    setFormDesc(site.description);
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
        setSites((prev) => prev.map((s) => (s.id === res.site.id ? res.site : s)));
        showToast('success', 'Сайт обновлён');
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
        showToast('success', `«${res.site.name}» добавлен в проверку`);
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения сайта');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (site: Site) => {
    const nextEnabled = !Boolean(site.enabled);
    setSites((prev) => prev.map((s) => (s.id === site.id ? { ...s, enabled: nextEnabled } : s)));
    try {
      await apiFetch(`/api/sites/${site.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: nextEnabled }),
      });
    } catch {
      setSites((prev) => prev.map((s) => (s.id === site.id ? { ...s, enabled: site.enabled } : s)));
      showToast('error', 'Не удалось изменить активность сайта');
    }
  };

  const handleDeleteSite = async (site: Site) => {
    const backup = sites;
    setSites((prev) => prev.filter((s) => s.id !== site.id));
    try {
      await apiFetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      showToast('info', `«${site.name}» удалён`);
    } catch {
      setSites(backup);
      showToast('error', 'Не удалось удалить сайт');
    }
  };

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
      showToast(
        result.status === 'ok' || result.status === 'slow' ? 'success' : 'warning',
        `${site.name}: ${
          result.latency_ms != null ? `отклик ${result.latency_ms} мс` : 'нет ответа'
        }`
      );
    } finally {
      setPingingId(null);
    }
  };

  const handleResetDefaults = async () => {
    setResetting(true);
    try {
      const res = await apiFetch<{ sites: Site[] }>('/api/sites/reset', { method: 'POST' });
      setSites(res.sites);
      showToast('success', `Восстановлено ${res.sites.length} сайтов`);
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

  const roleCounts = useMemo(
    () => ({
      whitelist: sites.filter((s) => roleOf(s) === 'whitelist').length,
      neutral: sites.filter((s) => roleOf(s) === 'neutral').length,
      rkn: sites.filter((s) => roleOf(s) === 'rkn').length,
    }),
    [sites]
  );

  const filteredSites = useMemo(
    () =>
      sites.filter((s) => {
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
      }),
    [sites, roleFilter, catFilter, statusFilter, search]
  );

  const enabledCount = sites.filter((s) => Boolean(s.enabled)).length;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-[22px] font-black tracking-tight">Каталог сайтов</h1>
        <p className="text-[12.5px] text-dim leading-snug">
          Активно {enabledCount} из {sites.length}. Белый список Минцифры — {roleCounts.whitelist},
          нейтральные — {roleCounts.neutral}, заблокированы РКН — {roleCounts.rkn}. Статусы сверены
          на ноябрь 2026. Здесь показан ответ веб-страницы; ручные проверки приложений находятся
          в карточках «Мои сервисы» и не помечают сайт как недоступный.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={openCreateModal}>
            Добавить сайт
          </Button>
          <Button
            variant="outline"
            size="md"
            loading={resetting}
            icon={<RotateCcw className="w-4 h-4" />}
            onClick={handleResetDefaults}
          >
            Вернуть базу
          </Button>
        </div>
      </header>

      {/* Поиск и фильтры */}
      <section className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск: youtube, госуслуги, steam"
            className={`${input} pl-9`}
            style={inputStyle}
          />
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ['whitelist', 'Белый список', 'var(--accent)', roleCounts.whitelist],
              ['neutral', 'Нейтральные', 'rgb(var(--success))', roleCounts.neutral],
              ['rkn', 'РКН', 'rgb(var(--danger))', roleCounts.rkn],
            ] as const
          ).map(([key, label, color, count]) => {
            const active = roleFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setRoleFilter(active ? 'all' : key)}
                className="rounded-xl border px-2 py-2 text-left tap"
                style={{
                  borderColor: active ? color : 'var(--line)',
                  background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'var(--surface)',
                }}
              >
                <div className="text-[15px] font-black font-mono leading-none" style={{ color }}>
                  {count}
                </div>
                <div className="text-[10px] text-dim mt-1 leading-tight font-semibold">{label}</div>
              </button>
            );
          })}
        </div>

        <div className="chip-rail">
          <Chip active={catFilter === 'all'} onClick={() => setCatFilter('all')}>
            Все ({sites.length})
          </Chip>
          <Chip active={statusFilter === 'ok'} onClick={() => setStatusFilter(statusFilter === 'ok' ? 'all' : 'ok')}>
            Доступные
          </Chip>
          <Chip
            active={statusFilter === 'blocked'}
            onClick={() => setStatusFilter(statusFilter === 'blocked' ? 'all' : 'blocked')}
          >
            Недоступные
          </Chip>
          <Chip
            active={statusFilter === 'disabled'}
            onClick={() => setStatusFilter(statusFilter === 'disabled' ? 'all' : 'disabled')}
          >
            Отключённые
          </Chip>
          {(Object.keys(CATEGORY_META) as SiteCategory[])
            .filter((c) => sites.some((s) => s.category === c))
            .map((c) => (
              <Chip
                key={c}
                active={catFilter === c}
                onClick={() => setCatFilter(catFilter === c ? 'all' : c)}
              >
                {CATEGORY_META[c].shortLabel}
              </Chip>
            ))}
        </div>
      </section>

      {/* Список */}
      {filteredSites.length === 0 ? (
        <div className="rounded-[1.5rem] border" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <EmptyState
            icon={<Globe className="w-5 h-5" />}
            title="Ничего не найдено"
            text={
              sites.length === 0
                ? 'Список пуст. Добавьте свой сайт или верните базовый набор.'
                : 'Под текущие фильтры не подходит ни один сайт.'
            }
            action={
              <Button
                variant="soft"
                size="md"
                onClick={() => {
                  setSearch('');
                  setCatFilter('all');
                  setStatusFilter('all');
                  setRoleFilter('all');
                }}
              >
                Сбросить фильтры
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          {filteredSites.map((site) => {
            const isEnabled = Boolean(site.enabled);
            const role = roleOf(site);
            const roleColor =
              role === 'whitelist'
                ? 'var(--accent)'
                : role === 'rkn'
                ? 'rgb(var(--danger))'
                : 'rgb(var(--success))';
            return (
              <article
                key={site.id}
                className="rounded-2xl border px-3 py-2.5"
                style={{
                  borderColor: 'var(--line)',
                  background: isEnabled ? 'var(--surface)' : 'var(--surface-2)',
                  opacity: isEnabled ? 1 : 0.62,
                }}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="w-1 self-stretch rounded-full shrink-0 my-1"
                    title={
                      role === 'whitelist' ? 'Белый список РФ' : role === 'rkn' ? 'Заблокирован РКН' : 'Нейтральный'
                    }
                    style={{ background: roleColor, opacity: 0.7 }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-bold truncate">{site.name}</span>
                      <span
                        className="text-[9px] font-bold px-1.5 py-0.5 rounded font-mono"
                        title={CATEGORY_META[site.category]?.label}
                        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                      >
                        {CATEGORY_META[site.category]?.shortLabel || 'свой'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10.5px] font-mono text-muted truncate">{site.domain}</span>
                      <span className="text-muted text-[9px]">·</span>
                      <StatusIcon status={site.last_status} className="w-3 h-3 shrink-0" />
                      <span className="text-[10.5px] text-dim shrink-0">
                        {site.last_status === 'ok'
                          ? `страница открыта · ${site.last_latency_ms} мс`
                          : site.last_status === 'slow'
                          ? `страница медленная · ${site.last_latency_ms} мс`
                          : site.last_status === 'blocked'
                          ? 'страница недоступна'
                          : 'не проверялся'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(site)}
                      title={isEnabled ? 'Участвует в проверке' : 'Отключён'}
                      aria-label={isEnabled ? 'Отключить сайт' : 'Включить сайт'}
                      className="w-9 h-5 rounded-full p-0.5 transition-colors"
                      style={{ background: isEnabled ? 'rgb(var(--accent))' : 'var(--line-strong)' }}
                    >
                      <span
                        className="block w-4 h-4 rounded-full bg-white transition-transform"
                        style={{ transform: isEnabled ? 'translateX(1rem)' : 'translateX(0)' }}
                      />
                    </button>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        disabled={pingingId === site.id}
                        onClick={() => handlePingSingleSite(site)}
                        title="Проверить сейчас"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--accent))]"
                      >
                        <Zap className={`w-3.5 h-3.5 ${pingingId === site.id ? 'animate-pulse' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(site)}
                        title="Изменить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--accent))]"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(site)}
                        title="Удалить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--danger))]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmSheet
        open={pendingDelete !== null}
        title="Удалить сайт?"
        text={
          pendingDelete
            ? `«${pendingDelete.name}» (${pendingDelete.domain}) больше не будет участвовать в замерах. Вернуть его можно кнопкой «Вернуть базу» или добавив заново.`
            : ''
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void handleDeleteSite(target);
        }}
      />

      {/* ---------- Модалка сайта ---------- */}
      <Sheet
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingSite ? 'Изменить сайт' : 'Новый сайт'}
        subtitle="Сайт участвует в замерах и влияет на вердикт"
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Globe className="w-4 h-4" />
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
              icon={<Check className="w-4 h-4" />}
              onClick={() =>
                (document.getElementById('site-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Сохранить
            </Button>
          </>
        }
      >
        <form id="site-form" onSubmit={handleSaveSite} className="space-y-3">
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Название</span>
            <input
              type="text"
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Например: Хабр"
              className={input}
              style={inputStyle}
            />
          </label>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Домен</span>
            <input
              type="text"
              required
              value={formDomain}
              onChange={(e) => setFormDomain(e.target.value)}
              placeholder="habr.com"
              className={`${input} font-mono`}
              style={inputStyle}
            />
          </label>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">
              URL проверки <span className="text-muted font-normal">— необязательно</span>
            </span>
            <input
              type="text"
              value={formProbeUrl}
              onChange={(e) => setFormProbeUrl(e.target.value)}
              placeholder="https://habr.com/favicon.ico"
              className={`${input} font-mono`}
              style={inputStyle}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Категория</span>
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value as SiteCategory)}
                className={input}
                style={inputStyle}
              >
                {(Object.keys(CATEGORY_META) as SiteCategory[]).map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_META[cat].shortLabel}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[11.5px] font-semibold text-dim mb-1.5 flex items-center gap-1">
                Роль
                <HelpCircle className="w-3 h-3" />
              </span>
              <select
                value={formMarkerRole}
                onChange={(e) => setFormMarkerRole(e.target.value as MarkerRole)}
                className={input}
                style={inputStyle}
              >
                <option value="global_neutral">Нейтральный</option>
                <option value="ru_whitelist">Белый список РФ</option>
                <option value="dpi_target">Под фильтрацией</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Заметка</span>
            <input
              type="text"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder="Короткое описание"
              className={input}
              style={inputStyle}
            />
          </label>

          <div
            className="rounded-xl border p-2.5 text-[11px] leading-relaxed text-dim"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
          >
            Роль определяет, как замер трактует результат: белый список должен работать даже при
            отключениях, нейтральные сайты — всегда, а сервисы под фильтрацией без VPN падают сами по
            себе.
          </div>
        </form>
      </Sheet>
    </div>
  );
};
