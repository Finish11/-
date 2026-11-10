import { useId, useState } from 'react'
import { Info } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { NetworkReport, Period } from '../lib/types'

const samples = {
  '24h': { ru: [92,94,94,93,97,96,96,94,97,97,95,97,97,98,95,97,96,97,97,98,96,97,98,98], global: [79,80,78,80,79,83,82,81,85,86,83,85,84,85,68,78,82,81,82,87,86,84,88,89] },
  '7d': { ru: [94,92,97,95,97,96,94,98,96,97,94,97,98,97,98,96,98,97,99,97,98], global: [72,76,74,79,82,79,77,81,79,82,66,75,80,83,79,84,82,86,85,87,89] },
  '30d': { ru: [88,92,90,95,93,96,94,97,95,97,93,97,96,98,97,98,96,99,97,98,98,97,99,98], global: [64,68,65,73,74,72,75,77,71,78,76,82,77,80,75,85,82,83,88,83,87,85,88,89] },
}

function smoothPath(points: [number, number][]) {
  return points.reduce((path, point, i, arr) => {
    if (i === 0) return `M ${point[0]} ${point[1]}`
    const previous = arr[i - 1], before = arr[i - 2] || previous, after = arr[i + 1] || point
    return `${path} C ${previous[0] + (point[0] - before[0]) / 6} ${previous[1] + (point[1] - before[1]) / 6}, ${point[0] - (after[0] - previous[0]) / 6} ${point[1] - (after[1] - previous[1]) / 6}, ${point[0]} ${point[1]}`
  }, '')
}

export function NetworkChart({ period, setPeriod, reports }: { period: Period; setPeriod: (period: Period) => void; reports: NetworkReport[] }) {
  const id = useId().replaceAll(':', '')
  const [hover, setHover] = useState<number | null>(null)
  const [viewTime] = useState(() => Date.now())
  const days = period === '24h' ? 1 : period === '7d' ? 7 : 30
  const actual = reports.filter(r => viewTime - Date.parse(r.date) <= days * 86400000).slice(0, 24).reverse()
  const isReal = actual.length > 0
  const series = isReal ? {
    ru: actual.map(r => r.groups?.ru ?? (r.available / r.total * 100)),
    global: actual.map(r => r.groups?.global ?? (r.available / r.total * 100)),
  } : samples[period]
  const minimum = isReal ? 0 : 40
  const labels = isReal ? actual.map(r => new Date(r.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })) : period === '24h' ? ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '23:59'] : period === '7d' ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['1', '5', '10', '15', '20', '25', '30']
  const x = (i: number, total: number) => 44 + (total === 1 ? 0.5 : i / (total - 1)) * 568
  const y = (value: number) => 15 + ((100 - value) / (100 - minimum)) * 132
  const ruPoints = series.ru.map((v, i) => [x(i, series.ru.length), y(v)] as [number, number])
  const globalPoints = series.global.map((v, i) => [x(i, series.global.length), y(v)] as [number, number])
  const ruPath = smoothPath(ruPoints), globalPath = smoothPath(globalPoints)
  const ticks = isReal ? [100, 75, 50, 25, 0] : [100, 80, 60, 40]
  return <section className="panel chart-panel"><div className="panel-heading"><div><h2>Динамика доступности <Link className="inline-info" to="/about#methodology" aria-label="О методике измерения"><Info size={14} /></Link></h2><p>Доля ресурсов, от которых получен ответ</p></div><div className="segment-control" aria-label="Период графика">{(['24h', '7d', '30d'] as Period[]).map(value => <button key={value} className={period === value ? 'active' : ''} onClick={() => { setPeriod(value); setHover(null) }} aria-pressed={period === value}>{value === '24h' ? '24 ч' : value === '7d' ? '7 д' : '30 д'}</button>)}</div></div>
    <div className="chart-legend"><span><i className="legend-line green-line" />Российские ресурсы</span><span><i className="legend-line purple-line" />Мировая инфраструктура</span></div>
    <div className="chart-canvas" tabIndex={0} aria-label="График доступности. Стрелки влево и вправо переключают точки." onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setHover(old => Math.max(0, Math.min(series.ru.length - 1, (old ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)))) } }} onMouseMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const normalized = (event.clientX - rect.left) / rect.width; setHover(Math.max(0, Math.min(series.ru.length - 1, Math.round((normalized * 640 - 44) / 568 * (series.ru.length - 1))))) }} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
      <svg viewBox="0 0 640 177" role="img" aria-label={isReal ? `Доступность по ${actual.length} вашим замерам` : 'Иллюстративный график доступности, демонстрационные данные'}>
        <defs><linearGradient id={`${id}-green`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#68bca5" stopOpacity=".14" /><stop offset="1" stopColor="#68bca5" stopOpacity="0" /></linearGradient><linearGradient id={`${id}-purple`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#9c8ad0" stopOpacity=".09" /><stop offset="1" stopColor="#9c8ad0" stopOpacity="0" /></linearGradient></defs>
        {ticks.map(tick => <g key={tick}><line x1="44" y1={y(tick)} x2="612" y2={y(tick)} stroke="#e9eeeb" strokeDasharray="3 4" /><text x="0" y={y(tick) + 3} fill="#8c9690" fontSize="9">{tick}%</text></g>)}
        {series.ru.length > 1 && <><path d={`${ruPath} L 612 148 L 44 148 Z`} fill={`url(#${id}-green)`} /><path d={`${globalPath} L 612 148 L 44 148 Z`} fill={`url(#${id}-purple)`} /><path d={globalPath} stroke="#a799cf" strokeWidth="2.3" strokeLinecap="round" fill="none" /><path d={ruPath} stroke="#359b7c" strokeWidth="2.5" strokeLinecap="round" fill="none" /></>}
        {series.ru.length === 1 && <><circle cx={ruPoints[0][0]} cy={ruPoints[0][1]} r="4" fill="#359b7c" /><circle cx={globalPoints[0][0]} cy={globalPoints[0][1]} r="4" fill="#a799cf" /></>}
        {labels.map((label, i) => (labels.length <= 7 || i % Math.ceil(labels.length / 6) === 0) && <text key={i} x={x(i, labels.length)} y="170" fill="#8c9690" fontSize="9" textAnchor="middle">{label}</text>)}
        {hover !== null && ruPoints[hover] && <g><line x1={ruPoints[hover][0]} x2={ruPoints[hover][0]} y1="12" y2="148" stroke="#b5c9bf" strokeDasharray="3 3" /><circle cx={ruPoints[hover][0]} cy={ruPoints[hover][1]} r="4" fill="#359b7c" stroke="white" strokeWidth="2" /><circle cx={globalPoints[hover][0]} cy={globalPoints[hover][1]} r="4" fill="#a799cf" stroke="white" strokeWidth="2" /></g>}
      </svg>
      {hover !== null && <div className="chart-tooltip" style={{ left: `${Math.max(12, Math.min(72, hover / Math.max(1, series.ru.length - 1) * 90))}%` }}><strong>{isReal ? labels[hover] : 'Демонстрационная точка'}</strong><span>Российские: {Math.round(series.ru[hover])}%</span><span>Мировые: {Math.round(series.global[hover])}%</span></div>}
    </div><div className="chart-caption"><span className={`tiny-dot ${isReal ? 'is-live' : ''}`} />{isReal ? 'Ваши измерения · обновляются после каждой проверки' : 'Демо-сценарий. Свои данные появятся после проверки.'}</div>
  </section>
}
