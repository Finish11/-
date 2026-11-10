import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Activity, ArrowUpRight, Check, ChevronRight, FileText, MapPin, Radar, X } from 'lucide-react'
import { usePulse } from '../lib/context'
import type { NetworkReport, ReportSource, ReportStatus } from '../lib/types'
import { formatDate, STATUS_META } from '../lib/utils'

export function Logo({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><span className="brand-symbol"><Activity size={25} strokeWidth={2.3} /></span>{!compact && <span className="brand-text">пульс<span>сети</span><small>открытый мониторинг</small></span>}</span>
}

export function StatusBadge({ status }: { status: ReportStatus }) {
  const meta = STATUS_META[status]
  return <span className={`badge status-badge ${meta.tone}`}><span className="status-dot" />{meta.label}</span>
}

export function SourceBadge({ source }: { source: ReportSource }) {
  const names: Record<ReportSource, string> = { demo: 'Пример', local: 'Локально', community: 'Сообщество', shared: 'По ссылке' }
  return <span className={`source-badge source-${source}`}>{names[source]}</span>
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const dialog = ref.current
    previousFocus.current = document.activeElement as HTMLElement
    dialog?.showModal()
    document.body.classList.add('modal-open')
    return () => {
      dialog?.close()
      document.body.classList.remove('modal-open')
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-inner"><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Закрыть окно" onClick={onClose}><X size={20} /></button></div>{children}</div>
  </dialog>
}

export function EmptyState({ title, description, action, compact = false }: { title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><span className="empty-icon"><Radar size={30} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p>{action}</div>
}

export function ReportTable({ reports, compact = false }: { reports: NetworkReport[]; compact?: boolean }) {
  const { openReport } = usePulse()
  return <div className="table-scroll"><table className={`report-table ${compact ? 'compact-table' : ''}`}><thead><tr><th>Отчёт</th><th>Регион</th><th>Оператор</th><th>Состояние</th><th>Дата замера</th><th><span className="sr-only">Открыть</span></th></tr></thead><tbody>{reports.map(report => <tr key={report.id} onClick={() => openReport(report)}>
    <td><div className="report-name-cell"><span className={`table-report-icon ${report.status === 'stable' ? 'mint' : ''}`}><FileText size={17} /></span><div><button className="table-title" onClick={event => { event.stopPropagation(); openReport(report) }}>{report.title}</button><div className="table-secondary"><SourceBadge source={report.source} /><span>{report.available} из {report.total} ресурсов</span></div></div></div></td>
    <td><span className="location-text"><MapPin size={13} />{report.region}</span></td><td><span className="operator"><i className={`operator-dot operator-${report.operator === 'МТС' ? 'mts' : report.operator === 'Ростелеком' ? 'rt' : report.operator === 'МегаФон' ? 'mf' : 'other'}`} />{report.operator}</span></td><td><StatusBadge status={report.status} /></td><td className="date-cell">{formatDate(report.date)}</td><td><button className="row-arrow" aria-label={`Открыть отчёт: ${report.title}`} onClick={event => { event.stopPropagation(); openReport(report) }}><ChevronRight size={17} /></button></td>
  </tr>)}</tbody></table></div>
}

export function Toast() {
  const { toast, dismissToast } = usePulse()
  if (!toast) return null
  return <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}><span className="toast-icon">{toast.tone === 'success' ? <Check size={18} /> : <Activity size={18} />}</span><p>{toast.message}</p><button onClick={dismissToast} className="icon-button" aria-label="Закрыть уведомление"><X size={16} /></button></div>
}

export function ExternalArrow() { return <ArrowUpRight size={15} /> }
