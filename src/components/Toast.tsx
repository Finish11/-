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

/**
 * Сообщения снизу — так они не перекрывают шапку и не «прыгают» перед глазами.
 * Показываем не больше трёх, остальные ждут в очереди.
 *
 * Тост висит ровно над нижней навигацией — на экране «VPN-узлы» он закрывал
 * кнопку «Проверить» и первую карточку узла, а длинное название сервиса
 * растягивало плашку на три строки. Поэтому текст ограничен тремя строками с
 * многоточием: полный текст всегда есть в том месте, откуда тост пришёл.
 */
export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  const visible = toasts.slice(-3);
  if (visible.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[95] pointer-events-none flex flex-col-reverse items-center gap-2 px-3 pb-[calc(4.75rem+env(safe-area-inset-bottom))] lg:pb-5">
      {visible.map((t) => {
        const meta =
          t.type === 'success'
            ? { color: 'rgb(var(--success))', Icon: CheckCircle2 }
            : t.type === 'error'
            ? { color: 'rgb(var(--danger))', Icon: XCircle }
            : t.type === 'warning'
            ? { color: 'rgb(var(--warning))', Icon: AlertTriangle }
            : { color: 'rgb(var(--accent))', Icon: Info };
        const { color, Icon } = meta;
        return (
          <div
            key={t.id}
            role="status"
            /**
             * Сам тост клики не ловит: он висит над навигацией и перекрывал
             * кнопки («Проверить» после «Узел добавлен» — тап уходил в пустую
             * плашку). Нажимается только крестик.
             */
            className="w-full max-w-sm flex items-start gap-2.5 rounded-2xl px-3.5 py-2.5 anim-fade-up"
            style={{
              background: 'color-mix(in srgb, var(--bg-elevated) 92%, transparent)',
              border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
              boxShadow: '0 16px 40px -20px rgba(0,0,0,.85)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color }} />
            <div className="flex-1 min-w-0 text-[12.5px] leading-snug line-clamp-3 break-words" title={t.message}>{t.message}</div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="tap-icon tap shrink-0 -mr-1 -mt-0.5 text-dim hover:text-[color:var(--text)] pointer-events-auto"
              aria-label="Скрыть"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
