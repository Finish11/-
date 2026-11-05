import React, { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import {
  RUSSIAN_CARRIERS,
  RUSSIAN_REGIONS,
  type Incident,
  type ScanRecord,
  type User,
} from '../types';
import { apiFetch } from '../lib/api';
import { Sheet } from './ui/Sheet';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { Button, Chip, EmptyState } from './ui/kit';

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

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3 py-2.5 rounded-xl text-[13px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

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
          body: JSON.stringify({ region, carrier, incident_type: incidentType, severity, status, title, description }),
        });
        setIncidents((prev) => prev.map((x) => (x.id === editing.id ? res.incident : x)));
        showToast('success', 'Отчёт обновлён');
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
        showToast('success', 'Отчёт опубликован в сводке');
      }
      setModalOpen(false);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения отчёта');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleUpvote = async (inc: Incident) => {
    const nextVoted = !inc.user_upvoted;
    const nextCount = Math.max(0, inc.upvotes + (nextVoted ? 1 : -1));
    setIncidents((prev) =>
      prev.map((x) => (x.id === inc.id ? { ...x, user_upvoted: nextVoted, upvotes: nextCount } : x))
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
    setIncidents((prev) => prev.map((x) => (x.id === inc.id ? { ...x, status: nextStatus } : x)));
    try {
      await apiFetch(`/api/incidents/${inc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      showToast('success', nextStatus === 'resolved' ? 'Отмечено: связь восстановлена' : 'Отчёт снова активен');
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
  const totalUpvotes = incidents.reduce((sum, i) => sum + i.upvotes, 0);

  const filtered = useMemo(
    () =>
      incidents.filter((inc) => {
        if (regionFilter !== 'all' && inc.region !== regionFilter) return false;
        if (carrierFilter !== 'all' && inc.carrier !== carrierFilter) return false;
        if (statusFilter !== 'all' && inc.status !== statusFilter) return false;
        return true;
      }),
    [incidents, regionFilter, carrierFilter, statusFilter]
  );

  const uniqueRegionsInFeed = Array.from(new Set(incidents.map((i) => i.region)));

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-[22px] font-black tracking-tight">Карта сбоев</h1>
        <p className="text-[12.5px] text-dim leading-snug">
          Регионы, где глушат мобильный интернет или включили белые списки. Отметки ставят такие же
          пользователи, как вы.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            Сообщить о сбое
          </Button>
        </div>
      </header>

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

      {filtered.length === 0 ? (
        <div className="rounded-[1.5rem] border" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <EmptyState
            icon={<AlertOctagon className="w-5 h-5" />}
            title="Сообщений нет"
            text="Если у вас ограничения или белые списки — добавьте первый отчёт по своему региону."
            action={
              <Button variant="soft" size="md" onClick={openCreate}>
                Добавить отчёт
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
                key={inc.id}
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

                <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t" style={{ borderColor: 'var(--line)' }}>
                  <Button
                    variant={inc.user_upvoted ? 'soft' : 'outline'}
                    size="sm"
                    icon={<ThumbsUp className="w-3.5 h-3.5" />}
                    onClick={() => handleToggleUpvote(inc)}
                  >
                    У меня так же · {inc.upvotes}
                  </Button>
                  {inc.is_owner && (
                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleToggleResolved(inc)}
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
              {editing ? 'Сохранить' : 'Опубликовать'}
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
    </div>
  );
};
