import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, ExternalLink, Globe2, Info, LoaderCircle, Plus, Radar, Search, Trash2, X } from 'lucide-react'
import { usePulse } from '../lib/context'
import { GROUP_LABELS } from '../lib/data'
import { probeSite } from '../lib/scanner'
import type { Site, SiteGroup } from '../lib/types'
import { EmptyState, Modal, PageHeader } from '../components/ui'

export function Resources() {
  const { sites, disabledSites, toggleSite, addSite, removeSite, siteResults, recordResult, notify } = usePulse()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [group, setGroup] = useState('all')
  const [page, setPage] = useState(1)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [newGroup, setNewGroup] = useState<SiteGroup>('global')
  const [formError, setFormError] = useState('')
  const [probing, setProbing] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Site | null>(null)
  const filtered = useMemo(() => sites.filter(site => (group === 'all' || site.group === group) && `${site.name} ${site.domain}`.toLowerCase().includes(query.toLowerCase())), [sites, group, query])
  const pages = Math.max(1, Math.ceil(filtered.length / 12))
  const currentPage = Math.min(page, pages)
  const rows = filtered.slice((currentPage - 1) * 12, currentPage * 12)
  const checkSite = async (site: Site) => {
    setProbing(old => [...old, site.id])
    const result = await probeSite(site)
    recordResult(result)
    setProbing(old => old.filter(id => id !== site.id))
    notify(result.status === 'unknown' ? `${site.name}: ответ не получен. Причину нельзя определить только по этому тесту.` : `${site.name}: ответ за ${result.latency} мс`, result.status === 'unknown' ? 'info' : 'success')
  }
  const submitSite = (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const url = new URL(domain.includes('://') ? domain : `https://${domain}`)
      if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || /^localhost$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\./i.test(url.hostname)) throw new Error('Укажите публичный домен с HTTPS, например example.com.')
      if (sites.some(site => site.domain === url.hostname)) throw new Error('Этот домен уже есть в каталоге.')
      addSite({ id: `custom-${crypto.randomUUID()}`, name: name.trim() || url.hostname, domain: url.hostname, probeUrl: `${url.origin}/favicon.ico`, group: newGroup, custom: true })
      setAddOpen(false); setName(''); setDomain(''); setFormError(''); setQuery(''); setGroup('all'); setPage(Math.ceil((sites.length + 1) / 12)); notify('Ресурс добавлен в ваш локальный каталог')
    } catch (error) { setFormError(error instanceof Error && error.message !== 'Invalid URL' ? error.message : 'Проверьте формат домена.') }
  }
  return <div className="page resources-page"><PageHeader title="Каталог сайтов" description="75 контрольных ресурсов из проекта. Настройте свой набор проверок." actions={<><button className="button secondary" onClick={() => setAddOpen(true)}><Plus size={16} />Добавить сайт</button><Link to="/scan" className="button primary"><Radar size={17} />Проверить сеть</Link></>} />
    <div className="category-cards"><button className={group === 'all' ? 'active' : ''} onClick={() => { setGroup('all'); setPage(1) }}><span className="category-icon all-category"><Globe2 size={21} /></span><span>Все ресурсы<strong>{sites.length}</strong></span></button>{(Object.keys(GROUP_LABELS) as SiteGroup[]).map(value => <button className={group === value ? 'active' : ''} key={value} onClick={() => { setGroup(value); setPage(1) }}><span className={`category-icon ${value}-category`}>{value === 'ru' ? 'RU' : value === 'global' ? <Globe2 size={21} /> : <Radar size={21} />}</span><span>{GROUP_LABELS[value]}<strong>{sites.filter(site => site.group === value).length}</strong></span></button>)}</div>
    <section className="panel resources-table-panel"><div className="filter-bar"><label className="search-field"><Search size={17} /><input aria-label="Поиск сайтов" placeholder="Название или домен сайта" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} />{query && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={14} /></button>}</label><span className="filter-count"><Check size={14} />В проверке: {sites.length - disabledSites.length} из {sites.length}</span></div>
      {rows.length ? <div className="table-scroll"><table className="resource-table"><thead><tr><th><span className="sr-only">Выбран</span></th><th>Ресурс</th><th>Группа</th><th>Последний результат</th><th>Отклик</th><th>Проверить</th></tr></thead><tbody>{rows.map(site => {
        const result = siteResults[site.id], busy = probing.includes(site.id)
        return <tr key={site.id} className={disabledSites.includes(site.id) ? 'disabled-resource' : ''}><td><input type="checkbox" aria-label={`Включить ${site.name} в проверку`} checked={!disabledSites.includes(site.id)} onChange={() => toggleSite(site.id)} /></td><td><div className="resource-name"><span className={`resource-letter ${site.group}`}>{site.name.charAt(0)}</span><span><strong>{site.name}{site.custom && <small className="custom-label">свой</small>}</strong><a href={`https://${site.domain}`} target="_blank" rel="noreferrer">{site.domain}<ExternalLink size={10} /></a></span></div></td><td><span className="resource-group">{GROUP_LABELS[site.group]}</span></td><td><span className={`resource-status ${result?.status || 'unverified'}`}><i />{busy ? 'Проверяем…' : result?.status === 'ok' ? 'Ответ получен' : result?.status === 'slow' ? 'Медленный ответ' : result?.status === 'unknown' ? 'Нет ответа' : 'Не проверен'}</span></td><td className="mono-number">{result?.latency != null ? `${result.latency} мс` : '—'}</td><td><div className="row-actions"><button className="icon-button" aria-label={`Проверить ${site.name}`} disabled={busy} onClick={() => { void checkSite(site) }}>{busy ? <LoaderCircle size={17} className="spinning" /> : <Radar size={17} />}</button>{site.custom && <button className="icon-button danger-text" aria-label={`Удалить ${site.name}`} onClick={() => setDeleteTarget(site)}><Trash2 size={15} /></button>}</div></td></tr>
      })}</tbody></table></div> : <EmptyState compact title="Такого ресурса пока нет" description="Попробуйте другое название или добавьте свой сайт." action={<button className="button secondary" onClick={() => { setQuery(''); setGroup('all') }}>Сбросить фильтры</button>} />}
      <div className="pagination"><span>{filtered.length ? `${(currentPage - 1) * 12 + 1}–${Math.min(currentPage * 12, filtered.length)} из ${filtered.length} ресурсов` : 'Ресурсы не найдены'}</span><div><button className="icon-button" disabled={currentPage <= 1} aria-label="Предыдущая страница" onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} /></button><span>{currentPage} <small>/ {pages}</small></span><button className="icon-button" disabled={currentPage >= pages} aria-label="Следующая страница" onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} /></button></div></div>
    </section><div className="notice subtle-notice"><Info size={17} /><p>Статусы появляются только после реальных запросов из вашего браузера. Группы унаследованы от исходного проекта и не указывают на официальный статус блокировки. Изменения каталога сохраняются локально.</p></div>
    {addOpen && <Modal title="Добавить ресурс" subtitle="Сайт будет доступен для проверки только в вашем каталоге." onClose={() => setAddOpen(false)}><form onSubmit={submitSite}><label className="form-field">Название<input autoFocus required value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Мой сайт" /></label><label className="form-field">Домен<input required value={domain} onChange={event => setDomain(event.target.value)} maxLength={253} placeholder="example.com" /></label><label className="form-field">Группа<select value={newGroup} onChange={event => setNewGroup(event.target.value as SiteGroup)}>{Object.entries(GROUP_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setAddOpen(false)}>Отмена</button><button className="button primary" type="submit"><Plus size={16} />Добавить ресурс</button></div></form></Modal>}
    {deleteTarget && <Modal title="Удалить ресурс?" subtitle={`${deleteTarget.name} исчезнет из вашего локального каталога.`} onClose={() => setDeleteTarget(null)}><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteTarget(null)}>Отмена</button><button className="button danger" onClick={() => { removeSite(deleteTarget.id); setDeleteTarget(null); notify('Ресурс удалён') }}><Trash2 size={15} />Удалить</button></div></Modal>}
  </div>
}
