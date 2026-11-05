import React, { useState } from 'react';
import { History, Bookmark, Pencil, Trash2, Eye, Radar, Check, Search } from 'lucide-react';
import type { ScanRecord } from '../types';
import { apiFetch } from '../lib/api';
import { Sheet } from './ui/Sheet';
import { ConfirmSheet } from './ui/ConfirmSheet';
import { Button, EmptyState, StatusIcon } from './ui/kit';

interface HistoryViewProps {
  scans: ScanRecord[];
  setScans: React.Dispatch<React.SetStateAction<ScanRecord[]>>;
  onGoToScanner: () => void;
  /** Больше не используется: цвета берутся из CSS-переменных. Оставлен для совместимости вызова. */
  darkMode?: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

const verdictColor = (v: ScanRecord['verdict']): string => {
  switch (v) {
    case 'WHITELIST_ACTIVE':
    case 'TOTAL_JAMMING':
      return 'rgb(var(--danger))';
    case 'SEVERE_RESTRICTIONS':
      return 'rgb(var(--warning))';
    case 'DPI_THROTTLING':
      return '#f59e0b';
    default:
      return 'rgb(var(--success))';
  }
};

const shortVerdict = (title: string): string => {
  const map: Record<string, string> = {
    WHITELIST_ACTIVE: 'белые списки',
    TOTAL_JAMMING: 'глушение',
    SEVERE_RESTRICTIONS: 'сильные ограничения',
    DPI_THROTTLING: 'замедление DPI',
    OPEN_INTERNET: 'интернет открыт',
  };
  return map[title] || title;
};

export const HistoryView: React.FC<HistoryViewProps> = ({
  scans,
  setScans,
  onGoToScanner,
  showToast,
}) => {
  const [inspectScan, setInspectScan] = useState<ScanRecord | null>(null);
  const [editScan, setEditScan] = useState<ScanRecord | null>(null);
  const [carrierLabel, setCarrierLabel] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ScanRecord | null>(null);

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2)',
    border: '1px solid var(--line)',
    color: 'var(--text)',
  };
  const input =
    'w-full px-3 py-2.5 rounded-xl text-[13px] outline-none focus:ring-2 focus:ring-[rgb(var(--accent)/0.3)]';

  const handleTogglePin = async (scan: ScanRecord) => {
    const nextPinned = !scan.pinned;
    setScans((prev) =>
      prev
        .map((s) => (s.id === scan.id ? { ...s, pinned: nextPinned } : s))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    );
    try {
      await apiFetch(`/api/scans/${scan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: nextPinned }),
      });
    } catch {
      setScans((prev) => prev.map((s) => (s.id === scan.id ? scan : s)));
      showToast('error', 'Не удалось закрепить замер');
    }
  };

  const openEdit = (scan: ScanRecord) => {
    setEditScan(scan);
    setCarrierLabel(scan.carrier_label);
    setNote(scan.note);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editScan) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ scan: ScanRecord }>(`/api/scans/${editScan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ carrier_label: carrierLabel, note }),
      });
      setScans((prev) => prev.map((s) => (s.id === editScan.id ? res.scan : s)));
      setEditScan(null);
      showToast('success', 'Замер обновлён');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (scan: ScanRecord) => {
    const backup = scans;
    setScans((prev) => prev.filter((s) => s.id !== scan.id));
    if (inspectScan?.id === scan.id) setInspectScan(null);
    try {
      await apiFetch(`/api/scans/${scan.id}`, { method: 'DELETE' });
      showToast('info', 'Запись замера удалена');
    } catch {
      setScans(backup);
      showToast('error', 'Ошибка удаления записи');
    }
  };

  const chartPoints = [...scans].reverse().slice(-10);

  const visible = scans.filter((s) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      (s.carrier_label || '').toLowerCase().includes(q) ||
      (s.isp || '').toLowerCase().includes(q) ||
      (s.note || '').toLowerCase().includes(q) ||
      (s.ip_address || '').includes(q)
    );
  });

  const avgGlobal = scans.length
    ? Math.round(scans.reduce((a, s) => a + s.global_ok_pct, 0) / scans.length)
    : 0;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h1 className="text-[22px] font-black tracking-tight">История</h1>
        <p className="text-[12.5px] text-dim leading-snug">
          Все замеры сохраняются здесь. Синяя полоса — сайты РФ, зелёная — нейтральные: если синяя
          высокая, а зелёная падает, включены белые списки.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" size="md" icon={<Radar className="w-4 h-4" />} onClick={onGoToScanner}>
            Новый замер
          </Button>
        </div>
      </header>

      {scans.length === 0 ? (
        <div className="rounded-[1.5rem] border" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <EmptyState
            icon={<History className="w-5 h-5" />}
            title="Пока пусто"
            text="Запустите первую проверку — результат сохранится здесь вместе с графиком доступности."
            action={
              <Button variant="soft" size="md" onClick={onGoToScanner}>
                Запустить проверку
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {chartPoints.length >= 2 && (
            <section
              className="rounded-[1.5rem] border p-3.5"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-[12.5px] font-bold">Динамика доступности</span>
                <div className="flex items-center gap-2.5 text-[10px] text-dim">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm" style={{ background: 'rgb(var(--accent))' }} />
                    РФ
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm" style={{ background: 'rgb(var(--success))' }} />
                    мир
                  </span>
                </div>
              </div>

              <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
                {chartPoints.map((pt) => (
                  <button
                    key={pt.id}
                    type="button"
                    onClick={() => setInspectScan(pt)}
                    className="shrink-0 w-[52px] rounded-lg px-1 py-1 tap"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    <div className="h-20 flex items-end justify-center gap-1">
                      <div className="w-2.5 h-full rounded-t-sm flex items-end" style={{ background: 'var(--line)' }}>
                        <div
                          className="w-full rounded-t-sm"
                          style={{ height: `${Math.max(5, pt.ru_ok_pct)}%`, background: 'rgb(var(--accent))' }}
                        />
                      </div>
                      <div className="w-2.5 h-full rounded-t-sm flex items-end" style={{ background: 'var(--line)' }}>
                        <div
                          className="w-full rounded-t-sm"
                          style={{
                            height: `${Math.max(5, pt.global_ok_pct)}%`,
                            background: pt.global_ok_pct <= 25 ? 'rgb(var(--danger))' : 'rgb(var(--success))',
                          }}
                        />
                      </div>
                    </div>
                    <div className="text-[9px] font-mono text-muted text-center mt-1">
                      {new Date(pt.created_at).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] text-muted mt-2">
                Средняя доступность нейтральных сайтов за всё время — {avgGlobal}%.
              </p>
            </section>
          )}

          <div className="relative">
            <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по оператору, IP, заметке"
              className={`${input} pl-9`}
              style={inputStyle}
            />
          </div>

          <div className="space-y-1.5">
            {visible.map((scan) => {
              const color = verdictColor(scan.verdict);
              return (
                <article
                  key={scan.id}
                  className="rounded-2xl border px-3 py-2.5"
                  style={{
                    borderColor: scan.pinned ? 'rgb(var(--accent) / 0.4)' : 'var(--line)',
                    background: 'var(--surface)',
                  }}
                >
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[9.5px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
                    >
                      {shortVerdict(scan.verdict)}
                    </span>
                    <span className="text-[10px] text-muted font-mono">
                      {new Date(scan.created_at).toLocaleString('ru-RU', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {scan.vpn_detected && (
                      <span
                        className="text-[9.5px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: 'rgb(var(--warning) / 0.15)', color: 'rgb(var(--warning))' }}
                      >
                        VPN · {scan.country_code}
                      </span>
                    )}
                    {scan.pinned && <Bookmark className="w-3 h-3 fill-current text-[rgb(var(--accent))]" />}
                  </div>

                  <div className="text-[12.5px] font-bold mt-1 truncate">
                    {scan.carrier_label || scan.isp}{' '}
                    <span className="font-mono text-[10px] font-normal text-muted">{scan.ip_address}</span>
                  </div>

                  <div className="flex items-center gap-3 text-[10.5px] text-dim font-mono mt-1 flex-wrap">
                    <span>
                      доступно{' '}
                      <strong className="text-[color:var(--text)]">
                        {scan.ok_sites + scan.slow_sites}/{scan.total_sites}
                      </strong>
                    </span>
                    <span>РФ {scan.ru_ok_pct}%</span>
                    <span>мир {scan.global_ok_pct}%</span>
                    <span>{scan.avg_latency_ms} мс</span>
                  </div>

                  {scan.note && (
                    <p className="text-[11px] text-dim italic mt-1 line-clamp-2">«{scan.note}»</p>
                  )}

                  <div className="flex items-center gap-0.5 mt-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<Eye className="w-3.5 h-3.5" />}
                      onClick={() => setInspectScan(scan)}
                    >
                      Детали
                    </Button>
                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleTogglePin(scan)}
                        title="Закрепить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--accent))]"
                      >
                        <Bookmark className={`w-3.5 h-3.5 ${scan.pinned ? 'fill-current text-[rgb(var(--accent))]' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(scan)}
                        title="Подпись и заметка"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--accent))]"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(scan)}
                        title="Удалить"
                        className="p-1.5 rounded-lg text-dim hover:text-[rgb(var(--danger))]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      <ConfirmSheet
        open={pendingDelete !== null}
        title="Удалить замер?"
        text={
          pendingDelete
            ? `Запись от ${new Date(pendingDelete.created_at).toLocaleString('ru-RU')} исчезнет из истории и с графика.`
            : ''
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void handleDelete(target);
        }}
      />

      {/* Детали замера */}
      <Sheet
        open={Boolean(inspectScan)}
        onClose={() => setInspectScan(null)}
        title={inspectScan ? inspectScan.verdict_title : ''}
        subtitle={
          inspectScan
            ? `${inspectScan.carrier_label} · ${inspectScan.ip_address} · ${new Date(
                inspectScan.created_at
              ).toLocaleString('ru-RU')}`
            : undefined
        }
        size="lg"
        footer={
          <Button variant="soft" size="md" block onClick={() => setInspectScan(null)}>
            Закрыть
          </Button>
        }
      >
        {inspectScan && (
          <div className="space-y-3">
            <p className="text-[12.5px] text-dim leading-relaxed">{inspectScan.verdict_summary}</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[
                ['РФ', `${inspectScan.ru_ok_pct}%`],
                ['мир', `${inspectScan.global_ok_pct}%`],
                ['DPI', `${inspectScan.dpi_ok_pct}%`],
                ['пинг', `${inspectScan.avg_latency_ms}`],
              ].map(([l, v]) => (
                <div
                  key={l}
                  className="rounded-xl border px-1.5 py-1.5 text-center"
                  style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
                >
                  <div className="text-[13px] font-black font-mono">{v}</div>
                  <div className="text-[9px] text-muted">{l}</div>
                </div>
              ))}
            </div>
            <div className="space-y-1">
              {inspectScan.results.map((r, i) => (
                <div
                  key={`${r.domain}-${i}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <StatusIcon status={r.status} className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[12px] font-semibold truncate">{r.name}</span>
                  <span className="text-[10px] text-muted font-mono truncate">{r.domain}</span>
                  <span className="ml-auto text-[10.5px] font-mono shrink-0 text-dim">
                    {r.latency_ms ? `${r.latency_ms} мс` : 'нет ответа'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      {/* Правка заметки */}
      <Sheet
        open={Boolean(editScan)}
        onClose={() => setEditScan(null)}
        title="Подпись замера"
        subtitle="Помогает вспомнить, где и на чём мерили"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" block onClick={() => setEditScan(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="md"
              block
              loading={saving}
              icon={<Check className="w-4 h-4" />}
              onClick={() =>
                (document.getElementById('scan-edit-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Сохранить
            </Button>
          </>
        }
      >
        <form id="scan-edit-form" onSubmit={handleSaveEdit} className="space-y-3">
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Оператор / место</span>
            <input
              type="text"
              value={carrierLabel}
              onChange={(e) => setCarrierLabel(e.target.value)}
              placeholder="Например: МТС, дача под Тулой"
              className={input}
              style={inputStyle}
            />
          </label>
          <label className="block">
            <span className="block text-[11.5px] font-semibold text-dim mb-1.5">Заметка</span>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Что заметили"
              className={input}
              style={inputStyle}
            />
          </label>
        </form>
      </Sheet>
    </div>
  );
};
