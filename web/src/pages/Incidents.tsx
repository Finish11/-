import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Info, MapPin, Radar, SignalZero, TriangleAlert } from 'lucide-react'
import { usePulse } from '../lib/context'
import { formatDate, percentage } from '../lib/utils'
import { EmptyState, PageHeader, SourceBadge, StatusBadge } from '../components/ui'

export function Incidents() {
  const { publicReports, openReport } = usePulse()
  const [filter, setFilter] = useState('all')
  const [realOnly, setRealOnly] = useState(false)
  const incidents = publicReports.filter(report => report.status !== 'stable' && (filter === 'all' || report.status === filter) && (!realOnly || report.source !== 'demo'))
  return <div className="page incidents-page"><PageHeader title="Сбои и ограничения" description="Наблюдения о проблемах с доступом. Не официальный источник о блокировках." actions={<Link className="button primary" to="/scan"><Radar size={17} />Сообщить о сбое</Link>} />
    <div className="notice amber-notice incident-notice"><TriangleAlert size={21} /><div><strong>Проверяем наблюдения, не делаем поспешных выводов</strong><p>Причина отсутствия ответа может быть в устройстве, операторе, защите сайта или браузере. Примеры ниже не описывают текущие события.</p></div></div>
    <div className="incidents-toolbar"><div className="pill-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все наблюдения</button><button className={filter === 'partial' ? 'active' : ''} onClick={() => setFilter('partial')}>Частичный доступ</button><button className={filter === 'limited' ? 'active' : ''} onClick={() => setFilter('limited')}>Мало ответов</button><button className={filter === 'offline' ? 'active' : ''} onClick={() => setFilter('offline')}>Почти нет ответов</button></div><label className="checkbox-field"><input type="checkbox" checked={realOnly} onChange={event => setRealOnly(event.target.checked)} /><span>Без примеров</span></label></div>
    {incidents.length ? <div className="incident-grid">{incidents.map(report => <article className="panel incident-card" key={report.id}><div className="incident-card-top"><span className={`incident-icon ${report.status === 'offline' ? 'red' : ''}`}>{report.status === 'offline' ? <SignalZero size={21} /> : <TriangleAlert size={21} />}</span><SourceBadge source={report.source} /><time>{formatDate(report.date, true)}</time></div><div className="incident-region"><MapPin size={14} />{report.region}<span>·</span>{report.operator}</div><h2>{report.title}</h2><p>{report.note}</p><div className="incident-access"><span>Ответили ресурсы</span><strong>{report.available} / {report.total}<small>{percentage(report.available, report.total)}%</small></strong></div><div className={`progress-track incident-progress ${report.status}`}><span style={{ width: `${report.available / report.total * 100}%` }} /></div><div className="incident-footer"><StatusBadge status={report.status} /><button className="text-link" onClick={() => openReport(report)}>Подробнее <ArrowRight size={14} /></button></div></article>)}</div> : <section className="panel"><EmptyState title="Таких наблюдений пока нет" description="В выбранной категории нет опубликованных отчётов. Вы можете поделиться собственным замером." action={<Link className="button primary" to="/scan">Проверить соединение <ArrowRight size={16} /></Link>} /></section>}
    <div className="notice subtle-notice"><Info size={17} /><p>Наблюдения загружаются из JSON на сервере сайта. Новые записи добавляет администратор после проверки; демонстрационные сценарии отмечены отдельно. <Link to="/reports">Перейти ко всем отчётам</Link></p></div>
  </div>
}
