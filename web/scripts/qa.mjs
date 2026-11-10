import http from 'node:http'
import { readFile, stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const root = path.resolve('dist')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip' }
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    let file = path.resolve(root, '.' + pathname)
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return }
    try { if (!(await stat(file)).isFile()) file = path.join(root, 'index.html') } catch { file = path.join(root, 'index.html') }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(500).end('Test server error') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
const errors = []
const blockedExternal = []
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
await context.route('https://**/*', route => { blockedExternal.push(route.request().url()); return route.abort('blockedbyclient') })
await mkdir('artifacts', { recursive: true })
const checks = []
async function check(name, test) { await test(); checks.push(name); console.log('PASS', name) }
async function go(route) { await page.goto(base + route); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200) }

try {
  await check('Overview, branding and chart period', async () => {
    await go('/')
    await page.getByRole('heading', { name: 'Обзор сети', exact: true }).waitFor()
    const response = await context.request.get(base + '/data/reports.json')
    assert.equal(response.status(), 200)
    assert.equal((await response.json()).reports.length, 5)
    assert.deepEqual(blockedExternal, [], 'The overview must not request external services')
    await page.screenshot({ path: 'artifacts/overview-desktop.png', fullPage: true })
    assert.match(await page.title(), /Пульс сети/)
    const before = await page.locator('.chart-canvas svg').innerHTML()
    await page.getByRole('button', { name: '7 д', exact: true }).click()
    assert.notEqual(await page.locator('.chart-canvas svg').innerHTML(), before)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  })
  await check('Public reports filter, detail and JSON export', async () => {
    await go('/reports')
    await page.getByRole('textbox', { name: 'Поиск отчётов' }).fill('Краснодар')
    assert.equal(await page.locator('.report-table tbody tr').count(), 1)
    await page.locator('.table-title').click()
    await page.getByRole('dialog').waitFor()
    assert.match(await page.getByRole('dialog').innerText(), /Это пример/)
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Скачать JSON' }).click()
    const file = await downloaded
    const data = JSON.parse(await readFile(await file.path(), 'utf8'))
    assert.equal(data.version, 1)
    assert.equal(data.demo, true)
    await page.getByRole('button', { name: 'Закрыть окно' }).click()
    await page.getByRole('button', { name: /Сообщество/ }).click()
    await page.getByRole('heading', { name: 'Первый отчёт может быть вашим' }).waitFor()
  })
  await check('Resource search, actual probe flow and catalog CRUD', async () => {
    await go('/sites')
    await page.getByRole('textbox', { name: 'Поиск сайтов' }).fill('Яндекс')
    assert.equal(await page.locator('.resource-table tbody tr').count(), 1)
    await page.route('https://ya.ru/favicon.ico?**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64') }))
    await page.getByRole('button', { name: 'Проверить Яндекс', exact: true }).click()
    await page.getByText('Ответ получен', { exact: true }).waitFor()
    await page.getByRole('checkbox', { name: 'Включить Яндекс в проверку' }).uncheck()
    await page.getByRole('checkbox', { name: 'Включить Яндекс в проверку' }).check()
    await page.getByRole('button', { name: 'Добавить сайт' }).click()
    await page.getByLabel('Название', { exact: true }).fill('QA resource')
    await page.getByLabel('Домен', { exact: true }).fill('example.org')
    await page.getByRole('button', { name: 'Добавить ресурс', exact: true }).click()
    await page.getByRole('textbox', { name: 'Поиск сайтов' }).fill('example.org')
    assert.equal(await page.locator('.resource-table tbody tr').count(), 1)
    await page.getByRole('button', { name: 'Удалить QA resource' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click()
    await page.getByRole('heading', { name: 'Такого ресурса пока нет' }).waitFor()
  })
  let shareUrl = '', publishedPayload = null
  await check('Complete browser scan and persistent history', async () => {
    await go('/scan')
    await page.route('https://**/*', async route => {
      if (route.request().url().includes('youtube.com')) return route.abort('failed')
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64') })
    })
    await page.getByLabel('Город / регион').fill('Москва')
    await page.getByLabel('Оператор').selectOption('МТС')
    await page.getByRole('button', { name: 'Начать проверку', exact: true }).click()
    await page.getByRole('heading', { name: 'Проверка завершена' }).waitFor({ timeout: 20000 })
    assert.equal(await page.locator('.probe-row').count(), 12)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pulsenet-v2:reports')))
    assert.equal(stored.length, 1)
    assert.equal(stored[0].total, 12)
    assert.equal(stored[0].available, 11)
    assert.equal(stored[0].source, 'local')
    await page.screenshot({ path: 'artifacts/scanner-desktop.png', fullPage: true })
    await page.getByRole('button', { name: 'Поделиться', exact: true }).click()
    shareUrl = await page.getByRole('textbox', { name: 'Ссылка на отчёт' }).inputValue()
    assert.equal(new URL(shareUrl).search, '')
    assert.match(new URL(shareUrl).hash, /^#report=/)
    await page.getByRole('button', { name: 'В общей ленте' }).click()
    const publishButton = page.getByRole('button', { name: 'Скачать для публикации' })
    assert.equal(await publishButton.isDisabled(), true)
    await page.getByRole('dialog').getByRole('checkbox').check()
    const exported = page.waitForEvent('download')
    await publishButton.click()
    const file = await exported
    publishedPayload = JSON.parse(await readFile(await file.path(), 'utf8'))
    assert.equal(publishedPayload.version, 1)
    assert.equal(publishedPayload.demo, false)
    assert.equal(publishedPayload.available, 11)
    assert.equal(publishedPayload.total, 12)
    await page.getByRole('button', { name: 'Закрыть окно' }).click()
    await go('/history')
    assert.equal(await page.locator('.history-entry').count(), 1)
    await page.reload()
    assert.equal(await page.locator('.history-entry').count(), 1)
  })
  await check('Report opens in a separate visitor session', async () => {
    const other = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    await other.route('https://**/*', route => route.abort('blockedbyclient'))
    const visitor = await other.newPage()
    await visitor.goto(shareUrl)
    await visitor.getByRole('dialog').waitFor()
    assert.match(await visitor.getByRole('dialog').innerText(), /По ссылке/)
    assert.match(await visitor.getByRole('dialog').innerText(), /Москва/)
    assert.equal(await visitor.locator('.report-results .probe-row').count(), 12)
    await visitor.goto(base + '/reports?' + new URL(shareUrl).hash.slice(1))
    await visitor.getByRole('dialog').waitFor()
    assert.match(await visitor.getByRole('dialog').innerText(), /Москва/)
    await other.close()
  })
  await check('Same-origin JSON report is loaded for every visitor and updates statistics', async () => {
    const other = await browser.newContext()
    await other.route('https://**/*', route => route.abort('blockedbyclient'))
    await other.route('**/data/reports.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, reports: [publishedPayload] }) }))
    const visitor = await other.newPage()
    await visitor.goto(base + '/reports')
    await visitor.getByRole('button', { name: /Сообщество/ }).click()
    await visitor.locator('.report-table tbody tr').waitFor()
    assert.equal(await visitor.locator('.report-table tbody tr').count(), 1)
    assert.match(await visitor.locator('.report-table tbody').innerText(), /Москва/)
    await visitor.goto(base + '/')
    await visitor.getByText('ПОСЛЕДНИЙ ОПУБЛИКОВАННЫЙ ЗАМЕР', { exact: true }).waitFor()
    assert.match(await visitor.locator('.featured-stat').innerText(), /91,7/)
    await other.close()
  })
  await check('Missing or malformed local JSON falls back to labeled demo data', async () => {
    const other = await browser.newContext()
    await other.route('https://**/*', route => route.abort('blockedbyclient'))
    const visitor = await other.newPage()
    for (const response of [{ status: 503, body: '{}' }, { status: 200, body: JSON.stringify({ version: 1, reports: [{ ...publishedPayload, total: -1 }] }) }]) {
      await other.route('**/data/reports.json', route => route.fulfill({ ...response, contentType: 'application/json' }))
      await visitor.goto(base + '/reports')
      await visitor.getByText(/Свежесть данных не подтверждена/).waitFor()
      assert.equal(await visitor.locator('.report-table tbody tr').count(), 5)
      assert.equal(await visitor.locator('.report-table .source-demo').count(), 5)
      await other.unroute('**/data/reports.json')
    }
    await other.close()
  })
  await check('VPN import, metadata-only export and deletion', async () => {
    await go('/vpn')
    await page.getByRole('button', { name: 'Импорт узлов' }).click()
    await page.getByLabel('Конфигурации', { exact: true }).fill('vless://secret-key-not-for-storage@example.org:443?security=reality#TestNode')
    await page.getByRole('button', { name: 'Импортировать', exact: true }).click()
    await page.getByRole('heading', { name: 'TestNode' }).waitFor()
    const stored = await page.evaluate(() => localStorage.getItem('pulsenet-v2:vpn-nodes'))
    assert.ok(!stored.includes('secret-key'))
    assert.match(stored, /example.org/)
    await page.getByRole('button', { name: 'Удалить узел TestNode' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click()
    await page.getByRole('heading', { name: 'Добавьте свои VPN-узлы' }).waitFor()
  })
  await check('History deletion confirmation', async () => {
    await go('/history')
    await page.getByRole('button', { name: 'Очистить историю' }).click()
    await page.getByRole('button', { name: 'Отмена' }).click()
    assert.equal(await page.locator('.history-entry').count(), 1)
    await page.getByRole('button', { name: 'Очистить историю' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click()
    await page.getByRole('heading', { name: 'Ваша история начинается с одного замера' }).waitFor()
  })
  await check('All routes render without horizontal page overflow', async () => {
    for (const route of ['/', '/scan', '/sites', '/reports', '/incidents', '/vpn', '/history', '/about', '/missing']) {
      await go(route)
      assert.equal(await page.locator('h1').count() + await page.locator('.empty-state h3').count() > 0, true, route)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, route)
    }
  })
  await check('Complete source archive is downloadable from the About page', async () => {
    await go('/about')
    const downloaded = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Скачать полный код', exact: true }).click()
    const download = await downloaded
    assert.equal(download.suggestedFilename(), 'puls-seti-source.zip')
    const archive = await readFile(await download.path())
    assert.equal(archive.readUInt32LE(0), 0x04034b50)
    for (const filename of ['package.json', 'package-lock.json', 'vite.config.js', 'index.html', 'src/App.tsx', 'src/main.tsx', 'public/data/reports.json', 'README.md', 'scripts/package-source.mjs', 'scripts/qa.mjs']) {
      assert.ok(archive.includes(Buffer.from('puls-seti/' + filename)), filename)
    }
  })
  await check('Mobile layout and responsive navigation', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await go('/')
    await page.screenshot({ path: 'artifacts/overview-mobile.png', fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
    await page.locator('.sidebar').getByRole('link', { name: /Каталог сайтов/ }).click()
    await page.getByRole('heading', { name: 'Каталог сайтов', exact: true }).waitFor()
    assert.equal(await page.locator('.sidebar-open').count(), 0)
    for (const route of ['/scan', '/reports', '/incidents', '/vpn', '/history', '/about']) {
      await go(route)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, route)
    }
  })
  assert.deepEqual(errors, [], 'No uncaught browser exceptions')
  assert.deepEqual(blockedExternal, [], 'No external dependencies were requested')
  console.log(`\n${checks.length} integration checks passed. No uncaught browser exceptions.`)
} catch (error) {
  await page.screenshot({ path: 'artifacts/qa-failure.png', fullPage: true })
  console.error('BROWSER STATE', await page.locator('main').innerText())
  throw error
} finally {
  await context.close()
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
