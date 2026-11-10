import { useState } from 'react'
import { Check, Copy, Download, FileText, Globe2, Info, Link2, LockKeyholeOpen, MapPin, Share2, ShieldCheck, Timer } from 'lucide-react'
import { usePulse } from '../lib/context'
import { GROUP_LABELS } from '../lib/data'
import type { NetworkReport, SiteGroup } from '../lib/types'
import { downloadFile, formatDate, percentage, publicPayload, reportLink } from '../lib/utils'
import { Modal, SourceBadge, StatusBadge } from './ui'

function ReportDetail({ report }: { report: NetworkReport }) {
  const { openReport, shareReport, notify } = usePulse()
  const [showResults, setShowResults] = useState(true)
  return <Modal wide title={report.title} subtitle={`Замер ${formatDate(report.date, true)}`} onClose={() => openReport(null)}>
    <div className="report-detail-meta"><StatusBadge status={report.status} /><SourceBadge source={report.source} /><span><MapPin size={14} />{report.region}</span><span>{report.operator}</span></div>
    {report.source === 'demo' && <div className="notice amber-notice"><Info size={17} /><p>Это пример из демонстрационной базы репозитория, а не актуальная сводка о сети.</p></div>}
    {(report.source === 'community' || report.source === 'shared') && <div className="notice"><Info size={17} /><p>Пользовательский отчёт. Результаты предоставлены автором и не прошли независимую проверку.</p></div>}
    <div className="report-metrics"><div><Globe2 size={19} /><span>Доступность</span><strong>{percentage(report.available, report.total)}<small>%</small></strong></div><div><FileText size={19} /><span>Получено ответов</span><strong>{report.available}<small> / {report.total}</small></strong></div><div><Timer size={19} /><span>Средний HTTP-отклик</span><strong>{report.latency ?? '—'}<small> мс</small></strong></div></div>
    {report.groups && <div className="report-groups"><h3>Доступность по группам</h3>{(Object.keys(GROUP_LABELS) as SiteGroup[]).map(group => <div className="group-progress" key={group}><div><span>{GROUP_LABELS[group]}</span><strong>{report.groups?.[group]}%</strong></div><div className="progress-track"><span style={{ width: `${report.groups?.[group] || 0}%` }} /></div></div>)}</div>}
    {report.note && <div className="report-note"><h3>Комментарий к замеру</h3><p>{report.note}</p></div>}
    {!!report.results?.length && <div className="report-results"><button className="disclosure-button" onClick={() => setShowResults(!showResults)} aria-expanded={showResults}>{showResults ? 'Скрыть' : 'Показать'} результаты по ресурсам <span>{report.results.length}</span></button>{showResults && <div className="result-scroll">{report.results.map((result, i) => <div className="probe-row" key={`${result.siteId}-${i}`}><span className={`probe-dot ${result.status}`} /><div><strong>{result.name}</strong><small>{result.domain}</small></div><span className={`probe-result ${result.status}`}>{result.status === 'unknown' ? 'Нет ответа' : `${result.latency} мс`}</span></div>)}</div>}</div>}
    <div className="method-note"><ShieldCheck size={16} /><p>Измеряется ответ на HTTP-запрос, не ICMP-пинг. Ошибка или таймаут могут быть связаны с CORS, защитой сайта или сетью — это не доказательство блокировки.{report.vpn ? ' Автор указал использование VPN.' : ''}</p></div>
    <div className="modal-actions"><button className="button secondary" onClick={() => { downloadFile(`pulsenet-${report.id}.json`, JSON.stringify(publicPayload(report), null, 2)); notify('Отчёт подготовлен к скачиванию') }}><Download size={16} />Скачать JSON</button><button className="button primary" onClick={() => { openReport(null); shareReport(report) }}><Share2 size={16} />Поделиться</button></div>
  </Modal>
}

function ShareDialog({ report }: { report: NetworkReport }) {
  const { shareReport, notify } = usePulse()
  const [tab, setTab] = useState<'link' | 'community'>('link')
  const [title, setTitle] = useState(report.title)
  const [region, setRegion] = useState(report.region)
  const [operator, setOperator] = useState(report.operator)
  const [note, setNote] = useState(report.note)
  const [consent, setConsent] = useState(false)
  const [copied, setCopied] = useState(false)
  const draft: NetworkReport = { ...report, title: title.trim() || report.title, region: region.trim() || 'Не указан', operator: operator.trim() || 'Не указан', note: note.trim() }
  const link = reportLink(draft)
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); notify('Ссылка скопирована — её может открыть любой пользователь'); setTimeout(() => setCopied(false), 2500) }
    catch { notify('Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.', 'info') }
  }
  return <Modal title="Поделиться результатом" subtitle="Больше наблюдений — точнее общая картина." onClose={() => shareReport(null)}>
    <div className="share-tabs"><button className={tab === 'link' ? 'active' : ''} onClick={() => setTab('link')}><Link2 size={16} />По ссылке</button><button className={tab === 'community' ? 'active' : ''} onClick={() => setTab('community')}><Globe2 size={16} />В общей ленте</button></div>
    <label className="form-field">Название отчёта<input value={title} maxLength={160} onChange={event => setTitle(event.target.value)} /></label>
    <div className="form-grid"><label className="form-field">Город / регион<input value={region} maxLength={100} onChange={event => setRegion(event.target.value)} /></label><label className="form-field">Оператор<input value={operator} maxLength={100} onChange={event => setOperator(event.target.value)} /></label></div>
    <label className="form-field">Комментарий<textarea value={note} maxLength={2000} rows={3} onChange={event => setNote(event.target.value)} placeholder="Что вы заметили? Не указывайте личные данные." /></label>
    {tab === 'link' ? <><div className="notice"><Link2 size={17} /><p>Отчёт хранится прямо в ссылке. Его увидит любой, кому вы её отправите, без регистрации. В общую ленту он автоматически не добавляется.</p></div><label className="form-field">Ссылка на отчёт<div className="copy-field"><input aria-label="Ссылка на отчёт" value={link} readOnly onFocus={event => event.target.select()} /><button className="icon-button" aria-label="Скопировать ссылку" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div></label><button className="button primary full-width" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</button></> : <>
      {report.source === 'demo' ? <div className="notice amber-notice"><Info size={18} /><p>Примеры нельзя публиковать как реальные наблюдения. Выполните свою проверку сети, чтобы добавить отчёт в общую ленту.</p></div> : <><div className="notice"><FileText size={18} /><p>Лента загружается из JSON на сервере этого сайта. Скачайте запись для администратора: после проверки он добавит её в /data/reports.json и обновит сайт. Скачивание не публикует отчёт автоматически и не отправляет его на сервер.</p></div><label className="checkbox-field consent-field"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>Я проверил регион, оператора и комментарий: запись можно публиковать, в ней нет чужих персональных данных и секретов.</span></label><button className="button primary full-width" disabled={!consent} onClick={() => { downloadFile(`pulsenet-public-${report.id}.json`, JSON.stringify(publicPayload(draft), null, 2)); notify('JSON подготовлен. В общую ленту его добавляет администратор после проверки.', 'info') }}><Download size={17} />Скачать для публикации</button></>}
    </>}
    <div className="share-privacy"><LockKeyholeOpen size={14} />IP-адрес и ключи VPN не добавляются в отчёт.</div>
  </Modal>
}

export function ReportModals() {
  const { viewedReport, sharedReport } = usePulse()
  return <>{viewedReport && <ReportDetail key={viewedReport.id} report={viewedReport} />}{sharedReport && <ShareDialog key={sharedReport.id} report={sharedReport} />}</>
}
