/**
 * Drives the built app in Chromium at an iPhone viewport: imports a generated
 * multi-year Timeline export through the real file input, then checks that the
 * day view, the map, day stepping, the year heatmap and deep links all work.
 *
 *   npm run test:e2e
 */
import { chromium, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, 'test', '.artifacts')
const FIXTURE = join(ARTIFACTS, 'Timeline.json')
const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`

mkdirSync(ARTIFACTS, { recursive: true })

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/** Playwright's bundled Chromium, wherever this environment put it. */
function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base || !existsSync(base)) return undefined
  const dir = readdirSync(base).find((d) => /^chromium-\d+$/.test(d))
  return dir ? join(base, dir, 'chrome-linux', 'chrome') : undefined
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))) 
  })
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('preview server never came up')
}

console.log('generating fixture…')
await run('node', ['test/fixture.mjs', FIXTURE])

console.log('building…')
await run('npx', ['vite', 'build'])

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
})

let browser
try {
  await waitForServer()

  browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ['--no-sandbox', '--no-proxy-server'],
  })
  const context = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  const page = await context.newPage()

  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  console.log('\nfirst run')
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.screenshot({ path: join(ARTIFACTS, '01-first-run.png') })
  check(
    'empty state invites you to add a source',
    (await page.locator('.empty__title').first().textContent()) === 'Nothing here yet',
  )

  console.log('\nimport')
  await page.locator('.tab', { hasText: 'Sources' }).click()
  await page.screenshot({ path: join(ARTIFACTS, '02-sources.png'), fullPage: true })

  const started = Date.now()
  await page.locator('input[accept=".json,.zip"]').setInputFiles(FIXTURE)
  await page.waitForSelector('.status--ok', { timeout: 180_000 })
  const importMsg = (await page.locator('.status--ok').textContent()) ?? ''
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  check('Timeline export imports', /Imported [\d,]+ location events/.test(importMsg), `${importMsg.trim()} in ${elapsed}s`)
  await page.screenshot({ path: join(ARTIFACTS, '03-imported.png'), fullPage: true })

  console.log('\nday view')
  await page.locator('.tab').first().click()
  await page.waitForSelector('.day__headline', { timeout: 15_000 })
  const headline = await page.locator('.day__headline').textContent()
  check('lands on a day with content rather than an empty today', Boolean(headline), headline ?? '')

  const stats = await page.locator('.stat').allTextContents()
  check('distances are shown in kilometres', stats.some((s) => /\d\s?km/.test(s)), stats.join(' | '))

  const polylines = await page.locator('.map__canvas polyline').count()
  const circles = await page.locator('.map__canvas circle').count()
  check('map draws a route and markers', polylines > 0 && circles > 0, `${polylines} polylines, ${circles} circles`)
  check('no basemap tiles are requested by default', (await page.locator('.map__canvas image').count()) === 0)
  await page.screenshot({ path: join(ARTIFACTS, '04-day.png') })

  const before = await page.locator('.topbar__day').textContent()
  await page.getByRole('button', { name: 'Previous day' }).click()
  await page.waitForTimeout(400)
  const after = await page.locator('.topbar__day').textContent()
  check('stepping back moves to a different day', before !== after, `${before} → ${after}`)

  console.log('\nyear view')
  await page.locator('.tab', { hasText: 'Years' }).click()
  await page.waitForTimeout(600)
  const years = await page.locator('.year__label').allTextContents()
  check('a decade of years renders', years.length >= 10, years.join(', '))

  const activeMetric = await page.locator('.btn--primary').first().textContent()
  check('opens on a metric that has data', activeMetric !== 'Photos', `showing ${activeMetric}`)

  const cells = page.locator('.cell:not(.cell--empty)')
  const cellCount = await cells.count()
  check('days are filled in', cellCount > 1000, `${cellCount} non-empty cells`)
  await page.screenshot({ path: join(ARTIFACTS, '05-years.png') })

  await page.getByRole('button', { name: 'Distance', exact: true }).click()
  await page.waitForTimeout(400)
  const shades = new Set(
    await cells.evaluateAll((els) => els.map((e) => e.className.match(/cell--l\d/)?.[0] ?? '')),
  )
  check('the heatmap uses more than one step', shades.size > 2, `${shades.size} steps in use`)
  await page.screenshot({ path: join(ARTIFACTS, '06-years-distance.png') })

  await cells.nth(40).click()
  await page.waitForTimeout(400)
  check('tapping a cell opens that day', (await page.locator('.day__headline').count()) === 1,
    (await page.locator('.topbar__day').textContent()) ?? '')

  console.log('\ndeep link and timezones')
  await page.goto(`${BASE}/#2023-05-12`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.day__headline', { timeout: 15_000 })
  const linkedDay = await page.locator('.topbar__day').textContent()
  check('a deep link opens that exact day', /May 12, 2023/.test(linkedDay ?? ''), linkedDay ?? '')

  const entries = await page.locator('.entry__title').allTextContents()
  check('the flight is recognised', entries.some((e) => /Flew/.test(e)), entries.join(' / '))
  const zones = await page.locator('.entry__zone').allTextContents()
  check(
    'a day crossing zones labels each time with its zone',
    zones.length >= 2 && new Set(zones).size > 1,
    zones.join(' / '),
  )
  check(
    'a category is never used as a place name in the headline',
    !/Flew to (Restaurant|Park|Gym|Work|Home)/.test((await page.locator('.day__headline').textContent()) ?? ''),
    (await page.locator('.day__headline').textContent()) ?? '',
  )
  await page.screenshot({ path: join(ARTIFACTS, '07-tokyo.png') })

  console.log('\nappearance')
  await page.locator('.tab', { hasText: 'Sources' }).click()
  await page.selectOption('#theme', 'light')
  await page.waitForTimeout(300)
  check(
    'light mode repaints the surface',
    (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) ===
      'rgb(252, 252, 251)',
  )
  await page.locator('.tab').first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(ARTIFACTS, '08-light.png') })

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  await browser?.close()
  server.kill()
}

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}`)
console.log(`screenshots in ${ARTIFACTS}`)
process.exit(failures.length === 0 ? 0 : 1)
