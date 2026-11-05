import React, { useState } from 'react';

interface ExpandableTextProps {
  text: string;
  className?: string;
  /** one — одна строка с многоточием; two — до двух строк. */
  collapsedLines?: 'one' | 'two';
  title?: string;
}

/**
 * Длинные имена конфигов не обрезаются безвозвратно: по нажатию раскрываются
 * полностью. Это спокойнее бегущей строки и работает одинаково мышью и пальцем.
 */
export const ExpandableText: React.FC<ExpandableTextProps> = ({
  text,
  className = '',
  collapsedLines = 'two',
  title,
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      className={`block max-w-full min-w-0 text-left tap ${className}`}
      title={title || (expanded ? 'Свернуть название' : `Показать полностью: ${text}`)}
      aria-expanded={expanded}
      aria-label={expanded ? `Свернуть название ${text}` : `Показать полное название ${text}`}
    >
      <span className={expanded ? 'block whitespace-normal break-words' : collapsedLines === 'one' ? 'block truncate' : 'line-clamp-2'}>
        {text}
      </span>
    </button>
  );
};
