import React from 'react';
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 left-4 sm:left-auto sm:w-96 z-[90] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const styles =
          t.type === 'success'
            ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100'
            : t.type === 'error'
            ? 'bg-rose-950/95 border-rose-500/40 text-rose-100'
            : t.type === 'warning'
            ? 'bg-amber-950/95 border-amber-500/40 text-amber-100'
            : 'bg-slate-900/95 border-sky-500/40 text-slate-100';

        const Icon =
          t.type === 'success'
            ? CheckCircle2
            : t.type === 'error'
            ? XCircle
            : t.type === 'warning'
            ? AlertTriangle
            : Info;

        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md transition-all ${styles}`}
          >
            <Icon className="w-5 h-5 shrink-0 mt-0.5 opacity-90" />
            <p className="text-sm font-medium leading-snug flex-1">{t.message}</p>
            <button
              onClick={() => onDismiss(t.id)}
              className="opacity-60 hover:opacity-100 transition-opacity p-0.5"
              aria-label="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
