import React, { useState } from 'react';
import {
  History,
  Bookmark,
  Pencil,
  Trash2,
  Eye,
  CheckCircle2,
  Clock,
  XCircle,
  Radar,
  X,
} from 'lucide-react';
import type { ScanRecord } from '../types';
import { apiFetch } from '../lib/api';

interface HistoryViewProps {
  scans: ScanRecord[];
  setScans: React.Dispatch<React.SetStateAction<ScanRecord[]>>;
  onGoToScanner: () => void;
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  scans,
  setScans,
  onGoToScanner,
  darkMode,
  showToast,
}) => {
  const [inspectScan, setInspectScan] = useState<ScanRecord | null>(null);
  const [editScan, setEditScan] = useState<ScanRecord | null>(null);
  const [carrierLabel, setCarrierLabel] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

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

  // Chronological points for SVG comparison chart (last 10 scans)
  const chartPoints = [...scans].reverse().slice(-10);

  const badgeForVerdict = (verdict: ScanRecord['verdict']) => {
    switch (verdict) {
      case 'WHITELIST_ACTIVE':
        return 'bg-rose-500/20 text-rose-400 border-rose-500/35';
      case 'TOTAL_JAMMING':
        return 'bg-red-500/20 text-red-400 border-red-500/35';
      case 'SEVERE_RESTRICTIONS':
        return 'bg-orange-500/20 text-orange-400 border-orange-500/35';
      case 'DPI_THROTTLING':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/35';
      default:
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/35';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight">История замеров и динамика</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Сравнение доступности Рунета и глобального интернета по всем вашим проверкам
          </p>
        </div>

        <button
          type="button"
          onClick={onGoToScanner}
          className="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs sm:text-sm flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Radar className="w-4 h-4" />
          Новый замер
        </button>
      </div>

      {/* Empty state */}
      {scans.length === 0 ? (
        <div
          className={`rounded-3xl border p-12 text-center ${
            darkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <History className="w-12 h-12 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold">История проверок пуста</h3>
          <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
            Нажмите большую кнопку «Проверить сеть» на главном экране — результаты каждого замера
            автоматически сохраняются здесь с графиком доступности.
          </p>
          <button
            type="button"
            onClick={onGoToScanner}
            className="mt-5 px-5 py-2.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-sm inline-flex items-center gap-2"
          >
            <Radar className="w-4 h-4" />
            Запустить первую проверку
          </button>
        </div>
      ) : (
        <>
          {/* Trend Comparison Chart (RU Whitelist % vs Global Neutral %) */}
          {chartPoints.length >= 2 && (
            <div
              className={`rounded-3xl border p-5 sm:p-6 ${
                darkMode ? 'bg-slate-900/70 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-sm font-bold">
                    График разрыва связности (индикатор «Белых списков»)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Когда синий столбец (перечень Минцифры) = 100%, а зелёный (незаблокированные сайты) падает к 0% —
                    включены белые списки
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-sky-400" /> Сайты РФ (%)
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-emerald-400" /> Нейтральные сайты (%)
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-3 items-end pt-4">
                {chartPoints.map((pt) => (
                  <button
                    key={pt.id}
                    type="button"
                    onClick={() => setInspectScan(pt)}
                    className={`p-2.5 rounded-2xl border text-left transition-all hover:border-sky-500/50 ${
                      darkMode ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="h-24 flex items-end justify-center gap-2 px-1">
                      <div className="w-3.5 bg-slate-800/60 rounded-t-md h-full flex items-end overflow-hidden">
                        <div
                          className="w-full bg-sky-400 rounded-t-md transition-all"
                          style={{ height: `${Math.max(6, pt.ru_ok_pct)}%` }}
                          title={`Сайты РФ: ${pt.ru_ok_pct}%`}
                        />
                      </div>
                      <div className="w-3.5 bg-slate-800/60 rounded-t-md h-full flex items-end overflow-hidden">
                        <div
                          className={`w-full rounded-t-md transition-all ${
                            pt.global_ok_pct <= 25 ? 'bg-rose-500' : 'bg-emerald-400'
                          }`}
                          style={{ height: `${Math.max(6, pt.global_ok_pct)}%` }}
                          title={`Нейтральные (не заблокированы): ${pt.global_ok_pct}%`}
                        />
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-center text-slate-400 mt-2 truncate">
                      {new Date(pt.created_at).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                    <div className="text-[10px] font-bold text-center truncate mt-0.5">
                      {pt.ru_ok_pct}% / {pt.global_ok_pct}%
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Scan History Cards */}
          <div className="space-y-3">
            {scans.map((scan) => (
              <div
                key={scan.id}
                className={`rounded-2xl border p-4 sm:p-5 transition-all ${
                  scan.pinned
                    ? darkMode
                      ? 'bg-slate-900/90 border-sky-500/40'
                      : 'bg-white border-sky-300 shadow-sm'
                    : darkMode
                    ? 'bg-slate-900/65 border-slate-800/90'
                    : 'bg-white border-slate-200 shadow-sm'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${badgeForVerdict(
                          scan.verdict
                        )}`}
                      >
                        {scan.verdict_title}
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        {new Date(scan.created_at).toLocaleString('ru-RU')}
                      </span>
                      {scan.vpn_detected && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          С VPN ({scan.country_code})
                        </span>
                      )}
                    </div>

                    <div className="text-sm font-bold">
                      {scan.carrier_label || scan.isp}{' '}
                      <span className="font-mono text-xs font-normal text-slate-400">
                        ({scan.ip_address})
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 font-mono">
                      <span>
                        Доступно:{' '}
                        <strong className="text-slate-200">
                          {scan.ok_sites + scan.slow_sites}/{scan.total_sites}
                        </strong>
                      </span>
                      <span>РФ: {scan.ru_ok_pct}%</span>
                      <span>Нейтральные: {scan.global_ok_pct}%</span>
                      <span>DPI: {scan.dpi_ok_pct}%</span>
                      <span>Пинг: ~{scan.avg_latency_ms} мс</span>
                    </div>

                    {scan.note && (
                      <p className="text-xs text-sky-400/90 italic pt-0.5">«{scan.note}»</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 self-start md:self-center shrink-0">
                    <button
                      type="button"
                      onClick={() => setInspectScan(scan)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                        darkMode
                          ? 'bg-slate-950 border-slate-800 hover:border-sky-500/50 text-sky-400'
                          : 'bg-slate-50 border-slate-200 hover:bg-sky-50 text-sky-600'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Детали ({scan.results.length})
                    </button>

                    <button
                      type="button"
                      onClick={() => handleTogglePin(scan)}
                      title="Закрепить"
                      className={`p-2 rounded-xl transition-colors ${
                        scan.pinned
                          ? 'text-sky-400 bg-sky-500/15'
                          : 'text-slate-400 hover:text-sky-400'
                      }`}
                    >
                      <Bookmark className={`w-4 h-4 ${scan.pinned ? 'fill-current' : ''}`} />
                    </button>

                    <button
                      type="button"
                      onClick={() => openEdit(scan)}
                      title="Изменить подпись/заметку"
                      className="p-2 rounded-xl text-slate-400 hover:text-sky-400"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDelete(scan)}
                      title="Удалить замер"
                      className="p-2 rounded-xl text-slate-400 hover:text-rose-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ==================== DETAILED SCAN INSPECTOR MODAL ==================== */}
      {inspectScan && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className={`w-full max-w-3xl max-h-[85vh] flex flex-col rounded-3xl border shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="p-5 sm:p-6 border-b border-slate-800/60 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-extrabold">{inspectScan.verdict_title}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {inspectScan.carrier_label} • {inspectScan.ip_address} •{' '}
                  {new Date(inspectScan.created_at).toLocaleString('ru-RU')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectScan(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 sm:p-6 overflow-y-auto space-y-4">
              <p className="text-sm text-slate-300">{inspectScan.verdict_summary}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {inspectScan.results.map((r, i) => (
                  <div
                    key={`${r.domain}-${i}`}
                    className={`px-3 py-2 rounded-xl border flex items-center justify-between text-xs ${
                      darkMode ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      {r.status === 'ok' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : r.status === 'slow' ? (
                        <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      )}
                      <span className="font-semibold truncate">{r.name}</span>
                      <span className="text-slate-500 font-mono truncate">{r.domain}</span>
                    </span>
                    <span
                      className={`font-mono font-semibold shrink-0 ml-2 ${
                        r.status === 'ok'
                          ? 'text-emerald-400'
                          : r.status === 'slow'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {r.latency_ms ? `${r.latency_ms} мс` : 'Блок'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== EDIT SCAN NOTE MODAL ==================== */}
      {editScan && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${
              darkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">Редактировать запись замера</h3>
              <button
                type="button"
                onClick={() => setEditScan(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Метка оператора / локации
                </label>
                <input
                  type="text"
                  value={carrierLabel}
                  onChange={(e) => setCarrierLabel(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Заметка</label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Комментарий к проверке..."
                  className={`w-full px-3.5 py-2 rounded-xl border text-sm ${
                    darkMode
                      ? 'bg-slate-950 border-slate-800 text-white'
                      : 'bg-slate-50 border-slate-300 text-slate-900'
                  }`}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditScan(null)}
                  className="px-4 py-2 rounded-xl text-sm text-slate-400"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 rounded-xl bg-sky-500 text-slate-950 font-bold text-sm"
                >
                  Сохранить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
