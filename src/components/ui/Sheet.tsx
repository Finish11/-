import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Шторка / диалог.
 *
 * Рендерится порталом прямо в <body>, поэтому её никто не «запирает» внутри
 * анимированного контейнера (именно из-за этого раньше весь фон размывался,
 * а сама панель уезжала вниз страницы).
 *
 * Поведение:
 *  • mobile — выезжает снизу, тянется вниз пальцем, чтобы закрыть;
 *  • desktop — всплывает по центру;
 *  • блокирует прокрутку страницы под собой;
 *  • закрывается по Esc и по клику на затемнение.
 */

export type SheetSize = 'sm' | 'md' | 'lg';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: SheetSize;
  /** Показать крестик в шапке */
  closable?: boolean;
  /** Не закрывать по клику на фон (например, пока идёт загрузка) */
  dismissable?: boolean;
  className?: string;
  /** Сдвиг панели на десктопе (по центру по умолчанию) */
  align?: 'center' | 'top';
}

const MAX_W: Record<SheetSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-xl',
  lg: 'sm:max-w-3xl',
};

export const Sheet: React.FC<SheetProps> = ({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  size = 'md',
  closable = true,
  dismissable = true,
  className = '',
  align = 'center',
}) => {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Esc + блокировка прокрутки страницы
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    const prevPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      setDragging(false);
    }
  }, [open]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const el = panelRef.current;
    if (!el) return;
    // Тянем только если внутренний скролл уже наверху
    if (el.scrollTop > 4) return;
    startY.current = e.touches[0].clientY;
    setDragging(true);
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!dragging) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta > 0) setDragY(delta);
    },
    [dragging]
  );

  const onTouchEnd = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (dragY > 96) {
      onClose();
      setDragY(0);
    } else {
      setDragY(0);
    }
  }, [dragging, dragY, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="overlay-root items-end sm:items-center justify-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div
        className="overlay-scrim anim-overlay"
        onClick={dismissable ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        className={`sheet-panel anim-sheet flex flex-col
          rounded-t-[1.75rem] sm:rounded-[1.5rem]
          max-h-[92dvh] sm:max-h-[86dvh]
          ${align === 'top' ? 'sm:mt-[-6vh]' : ''}
          ${MAX_W[size]} ${className}`}
        style={{
          transform: dragY ? `translate3d(0, ${dragY}px, 0)` : undefined,
          transition: dragging ? 'none' : 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Ручка (только мобильный жест) */}
        <div className="sm:hidden shrink-0 pt-1 pb-0.5">
          <div className="sheet-grabber" />
        </div>

        {(title || closable) && (
          <div className="shrink-0 px-5 pt-3 pb-3 flex items-start gap-3">
            {icon && <div className="shrink-0 mt-0.5">{icon}</div>}
            <div className="min-w-0 flex-1">
              {title && (
                <h2 className="text-[1.05rem] font-bold leading-snug tracking-tight">{title}</h2>
              )}
              {subtitle && (
                <p className="text-xs text-dim mt-0.5 leading-snug">{subtitle}</p>
              )}
            </div>
            {closable && (
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 -mr-1 -mt-0.5 p-2 rounded-xl text-dim hover:text-[color:var(--text)] hover:bg-[color:var(--surface-2)] tap"
                aria-label="Закрыть"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Контент прокручивается только сам — страница под ним заперта */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          {children}
        </div>

        {footer && (
          <div
            className="shrink-0 px-5 py-3 border-t flex items-center gap-2"
            style={{ borderColor: 'var(--line)', background: 'var(--bg-elevated)' }}
          >
            {footer}
          </div>
        )}
        <div className="sm:hidden shrink-0" style={{ height: 'env(safe-area-inset-bottom)' }} />
      </div>
    </div>,
    document.body
  );
};
