import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Sheet } from './Sheet';
import { Button } from './kit';

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  text?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Подтверждение опасного действия. Одна случайная тапа не должна
 * удалять подписку с десятком узлов или запись замера.
 */
export const ConfirmSheet: React.FC<ConfirmSheetProps> = ({
  open,
  title,
  text,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  danger = true,
  loading = false,
  onConfirm,
  onCancel,
}) => (
  <Sheet
    open={open}
    onClose={onCancel}
    title={title}
    size="sm"
    icon={
      <div
        className="w-9 h-9 rounded-xl grid place-items-center"
        style={{
          background: danger ? 'rgb(var(--danger) / 0.14)' : 'var(--accent-soft)',
          color: danger ? 'rgb(var(--danger))' : 'rgb(var(--accent))',
        }}
      >
        <AlertTriangle className="w-4 h-4" />
      </div>
    }
    footer={
      <>
        <Button variant="ghost" size="md" block onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          size="md"
          block
          loading={loading}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    {text && <div className="text-[12.5px] text-dim leading-relaxed">{text}</div>}
  </Sheet>
);
