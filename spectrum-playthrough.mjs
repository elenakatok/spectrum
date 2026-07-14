/**
 * Spectrum SINGLE-ROLE Phase A SKELETON — EMULATOR play-through (Playwright, real browser).
 *
 * A UI-driven regression harness for the BLANK-CANVAS skeleton (no trading market — that
 * arrives in Slices 0–8). Proves the generic launch→KC→match→finalize→gradebook-push stack
 * stands up on Spectrum's identity. Students bootstrap via the DEV `?_pid=&_gid=` bypass;
 * the instructor is driven via the REAL dashboard buttons (Generate Code / Match Now /
 * Score & Record); reads hit the emulator Firestore REST endpoint with `Bearer owner`.
 *
 * DISCIPLINE (carried from eBay/Baxter):
 *  • Every student transition is a real CLICK / FILL in the browser — never a backend call.
 *  • CLEAN-START UNCONDITIONALLY: tears down + rebuilds the whole local stack every run.
 *  • The gradebook push is OBSERVED for real: a mock classroom callback is wired via
 *    functions/.env.local BEFORE the emulator boots, so the dashboard "Score & Record"
 *    button's real POST lands on it. Nothing is stubbed to pass.
 *
 * NAMED ASSERTION (Phase A): a placeholder grade (PARTICIPATION + KC only, portfolio value
 * NEVER graded) pushes end-to-end to the classroom callback — a real POST per present
 * trader carrying raw_score 1 + a knowledge_check_score, with NO market/portfolio value in
 * the payload, and the true no-show delivered as normalized_score −2 / status no_show.
 *
 * COVERAGE (student launch → grade push):
 *   1. Every student launches as the single role `trader` (no role branch).
 *   2. KC skeleton: the single-option role gate ("What is your role in this market?" →
 *      Trader, always true → passes first click) + 2 PLACEHOLDER graded statics. Options
 *      shuffle per student (drive selects by label text). One student gets 1/2, one 0/2
 *      (a wrong answer never blocks), the rest 2/2.
 *   3. Info-document phase: the Trader role-sheet link is present AND resolves.
 *   4. Instructor dashboard loads, roster visible, Generate Code, Match.
 *   5. Match: 4 attendees → [4] (single-role tiling); the true no-show is held out.
 *   6. matched → MARKET ROOM (data-testid market-room), reload stays coherent.
 *   7. Finalize: Score & Record → participation+KC scoring → real grade push (POST + 200):
 *      present traders all get the SAME flat raw (degenerate pool → z 0); KC (0–1) rides as
 *      its own field with the real values; NO portfolio value anywhere; the true no-show is
 *      raw null / z −2 / status no_show; nobody dropped.
 *
 * ── ONE-COMMAND RUN ──────────────────────────────────────────────────────────
 *   From the spectrum repo root (where playwright resolves):
 *     node spectrum-playthrough.mjs
 *   Env: HEADED=1 to watch the browsers; SLOWMO=80 to slow clicks.
 *   (one-time: `npm install` at games/spectrum to install the declared playwright devDependency)
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ─────────────────────────────────────────────────────────────────────

const PROJECT   = 'spectrum-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FE        = process.env.FE_BASE ?? 'http://localhost:5173'
const FUNCTIONS = process.env.FN_BASE ?? `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = process.env.FS_BASE ?? `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const HEADED    = process.env.HEADED === '1'
const SLOWMO    = process.env.SLOWMO ? Number(process.env.SLOWMO) : 0

// Emulator + Vite ports (source: firebase.json emulators block + Vite default).
const PORTS = [9101, 5005, 8082, 9002, 5006, 4002, 5173]

// A fresh instance id per run so re-runs never collide.
const GID  = process.env.GID ?? `pt-${Date.now()}`
// 5 students. ONE is the TRUE NO-SHOW (launches + completes KC, never attends class);
// the other 4 attend → single-role matching tiles to [4] (one group). The held-back
// no-show proves the −2 floor. composition {trader:4}.
const PIDS = Array.from({ length: 5 }, (_, i) => `stu-${i + 1}`)
const NOSHOW_PID  = PIDS[PIDS.length - 1]              // stu-5 — launches + KC, never attends
const ATTEND_PIDS = PIDS.filter(p => p !== NOSHOW_PID) // the 4 who attend → [4]

// ── KC skeleton: single-option gate + 2 PLACEHOLDER graded statics ──────────────
// For each static, a UNIQUE substring of the CORRECT option label and of a WRONG option
// label — the drive selects by TEXT so it is immune to the per-student option shuffle.
// (Verbatim from gameDefinition.ts prepDefaults; these are PLACEHOLDERS replaced in Slice 6.)
const KC_FIELDS  = ['kc_stub_one', 'kc_stub_two']
const KC_CORRECT = {
  kc_stub_one: 'the correct placeholder answer',
  kc_stub_two: 'The true placeholder statement',
}
const KC_WRONG = {
  kc_stub_one: 'A wrong placeholder answer',
  kc_stub_two: 'A false placeholder statement',
}
// Answer plan by pid: stu-1 → 1/2 (score 0.5); stu-2 → 0/2 (score 0); all others → 2/2 (1.0).
const KC_HALF_PID = PIDS[0]   // stu-1
const KC_ZERO_PID = PIDS[1]   // stu-2
function kcPlanFor(pid) {
  if (pid === KC_HALF_PID) return new Set(['kc_stub_one'])
  if (pid === KC_ZERO_PID) return new Set()
  return new Set(KC_FIELDS)     // everyone else answers both correctly
}

// ── Tiny test harness ──────────────────────────────────────────────────────────

let PASS = 0, FAIL = 0
const log    = (tag, msg) => console.log(`[${tag}] ${msg}`)
const banner = msg => console.log('\n' + '─'.repeat(66) + '\n' + msg + '\n' + '─'.repeat(66))
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✓ ASSERT: ${name}`) }
  else      { FAIL++; console.log(`  ✗ ASSERT FAILED: ${name}`) }
}

// ── On-failure diagnostics (never affects pass/fail) ────────────────────────────

let browser = null
const students = []      // { page, pid, role }
let dash = null          // instructor dashboard page
const ARTIFACT_DIR = path.resolve(ROOT, 'playthrough-artifacts', GID)

async function headingText(page) {
  try {
    const hs = (await page.locator('h1').allTextContents()).map(h => h.trim()).filter(Boolean)
    return hs.length ? hs.join(' | ') : '(no <h1> visible)'
  } catch { return '(could not read <h1>)' }
}
async function dumpDiagnostics(reason) {
  console.log('\n' + '═'.repeat(66) + '\nDIAGNOSTIC DUMP — ' + reason + '\n' + '═'.repeat(66))
  try { mkdirSync(ARTIFACT_DIR, { recursive: true }) } catch { /* best effort */ }
  const targets = [
    ...students.map(s => ({ label: s.pid, page: s.page })),
    ...(dash ? [{ label: 'dashboard', page: dash }] : []),
  ]
  for (const { label, page } of targets) {
    if (!page) continue
    const heading = await headingText(page)
    let url = '(unknown)'; try { url = page.url() } catch { /* closed */ }
    let shot = path.join(ARTIFACT_DIR, `${label}.png`)
    try { await page.screenshot({ path: shot, fullPage: true }) } catch (e) { shot = `(screenshot failed: ${e.message})` }
    console.log(`  [${label}]  heading: ${heading}`)
    console.log(`  ${' '.repeat(label.length)}   url: ${url}`)
    console.log(`  ${' '.repeat(label.length)}   shot: ${shot}`)
  }
  console.log('═'.repeat(66) + '\n')
}

// ── Firestore REST helpers (emulator; owner auth bypasses rules) ────────────────

async function fsGetDocs(collection) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=100`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return []
  return (await res.json()).documents ?? []
}
async function fsGetDoc(pathSuffix) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${pathSuffix}`, {
    headers: { Authorization: 'Bearer owner' },
  })
  if (!res.ok) return null
  return res.json()
}
const strVal = f => f?.stringValue ?? ''
const numVal = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue ?? null))
const arrVal = f => (f?.arrayValue?.values ?? []).map(v => v.stringValue)

async function readParticipants() {
  const docs = await fsGetDocs('participants')
  return docs.map(d => ({
    id:               d.name.split('/').pop(),
    role:             strVal(d.fields?.role),
    is_lead:          d.fields?.is_lead?.booleanValue ?? false,
    group_id:         strVal(d.fields?.group_id),
    raw_score:        numVal(d.fields?.raw_score),
    normalized_score: numVal(d.fields?.normalized_score),
    knowledge_check_score: numVal(d.fields?.knowledge_check_score),
  }))
}
async function readGroups() {
  const docs = await fsGetDocs('groups')
  return docs.map(d => ({
    id:      d.name.split('/').pop(),
    status:  strVal(d.fields?.status),
    traders: arrVal(d.fields?.trader_participants),   // single-role membership
    lead:    strVal(d.fields?.lead_participant_id),
  }))
}
async function pollGroups(pred, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const gs = await readGroups()
    if (gs.length && pred(gs)) return gs
    await sleep(700)
  }
  return readGroups()
}
async function pollParticipants(pred, maxMs = 30_000) {
  const start = Date.now()
  let ps = await readParticipants()
  while (Date.now() - start < maxMs) {
    ps = await readParticipants()
    if (ps.length && pred(ps)) return ps
    await sleep(700)
  }
  return ps
}
async function readAttendanceCode() {
  const doc = await fsGetDoc('attendance_code/current')
  return doc?.fields?.code?.stringValue ?? null
}

// ── Student / dashboard URLs (DEV bypasses) ─────────────────────────────────────

const studentUrl   = pid => `${FE}/?_pid=${pid}&_gid=${GID}&_session=tab`
const dashboardUrl = () => `${FE}/dashboard?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`
const bodyText     = page => page.locator('body').innerText()

// ── Phase 1: info → KC gate → graded MC → reflection → hold (per student) ───────

// assignRole runs a Firestore transaction on ONE shared role_counts doc; the emulator locks
// pessimistically, so concurrent assignRole calls cascade into lock-timeouts. So role
// assignment is driven SEQUENTIALLY; everything AFTER the role page runs concurrently.
async function ensureOnRolePage(page, pid) {
  let onRole = false
  for (let attempt = 1; attempt <= 6 && !onRole; attempt++) {
    await page.goto(studentUrl(pid))
    onRole = await page.waitForSelector('p:has-text("Your role")', { timeout: 20_000 }).then(() => true).catch(() => false)
    if (!onRole) { log(pid, `role-assign attempt ${attempt} not ready — reloading`); await sleep(1500) }
  }
  if (!onRole) throw new Error(`${pid} never reached the role page`)
}

// Drive the KC skeleton: single-option role gate + 2 PLACEHOLDER graded statics. Selects
// options by UNIQUE label text (immune to the per-student option shuffle). Returns proof info.
async function driveKnowledgeCheck(page, pid, correctSet) {
  // ── Gate (Q0): one option "Trader" — always the true role → passes on the first click ──
  await page.waitForSelector('p:has-text("Knowledge check")', { timeout: 30_000 })
  await page.locator('main label', { hasText: 'Trader' }).first().click()
  await page.locator('button:has-text("Submit")').click()

  // ── graded statics (in prepDefaults order) ──
  const orders = {}
  let staticsSeen = 0
  for (let i = 0; i < KC_FIELDS.length; i++) {
    const field = KC_FIELDS[i]
    // Wait for THIS question by its correct-option label (robust to the "N of M" stepper wording).
    await page.locator('main label', { hasText: KC_CORRECT[field] }).first().waitFor({ timeout: 30_000 })
    staticsSeen++
    orders[field] = (await page.locator('main label').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim())
    const pick = correctSet.has(field) ? KC_CORRECT[field] : KC_WRONG[field]
    await page.locator('main label', { hasText: pick }).first().click()
    await page.locator('button:has-text("Submit")').click()
    // Post-answer: ✓/✗ + explanation, then Continue (a wrong answer NEVER blocks progress).
    await page.waitForSelector('button:has-text("Continue")', { timeout: 15_000 })
    await page.locator('button:has-text("Continue")').click()
  }
  return { orders, staticsSeen, sawGate: true }
}

async function driveSetup(page, pid) {
  // SINGLE ROLE: everyone is a Trader (the info page shows "Your role: Trader").
  const roleLabel = ((await page.locator('h1').first().textContent()) ?? '').trim()
  log(pid, `info: "${roleLabel}" (trader)`)

  // Info-document phase: the ONE placeholder role-sheet PDF for the single role.
  const sheetLink = page.locator('a', { hasText: 'Role sheet' }).first()
  await sheetLink.waitFor({ timeout: 15_000 })
  const href = await sheetLink.getAttribute('href')
  assert(href === '/role-info/spectrum.pdf',
    `Info doc — the trader role-sheet link points at /role-info/spectrum.pdf (href=${href})`)

  await page.click('button:has-text("Continue")')

  // KC skeleton — single-option role gate + 2 placeholder graded statics.
  const kc = await driveKnowledgeCheck(page, pid, kcPlanFor(pid))

  // Reflection (ungraded, category 'preparation') — PrepQuestions phase.
  await page.waitForSelector('textarea', { timeout: 30_000 })
  await page.locator('textarea').fill(`Trader plan: build synergy in my strong regions, trade for the rest.`)
  await page.click('button:has-text("Complete")')

  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 30_000 })
  log(pid, '◆ hold screen')
  return { page, pid, role: 'trader', kc }
}

// ── Phase 1b: hold → confirmation → attendance code → waiting room ──────────────

async function driveToWaiting(s, code) {
  const { page, pid } = s
  await page.click('button:has-text("in class")')
  await page.waitForSelector('h1:has-text("Ready to join the market?")', { timeout: 20_000 })
  await page.click("button:has-text(\"Yes, I'm ready\")")
  await page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 20_000 })
  await page.locator('input').fill(code)
  await page.click('button[type="submit"]')
  await page.waitForSelector('h1:has-text("Waiting to be matched")', { timeout: 30_000 })
  log(pid, '★ waiting room')
}

// ── Local stack lifecycle (unconditional clean-start) ───────────────────────────

const children = []
function freePorts() {
  for (const p of PORTS) {
    try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* none */ }
  }
}
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try { const res = await fetch(url, { method: 'GET' }); if (res.status > 0) return } catch { /* not up */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} (${url}) never became ready`)
    await sleep(700)
  }
}
function spawnLogged(cmd, args, cwd, logFile) {
  const out = openSync(logFile, 'a')
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', out, out] })
  children.push(child)
  return child
}

async function startMockCallback() {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      try { received.push({ auth: req.headers.authorization, result: JSON.parse(body) }) }
      catch { received.push({ auth: req.headers.authorization, result: body }) }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { port, received, close: () => new Promise(r => server.close(r)) }
}

async function bringUpStack(mockPort) {
  banner('CLEAN-START — tear down + rebuild the local stack (unconditional)')
  freePorts()
  await sleep(1200)

  // Wire the mock classroom callback into the emulator BEFORE it boots (functions/.env.local
  // is gitignored + emulator-only; the prod callback URL in functions/.env is untouched).
  const cb = `http://127.0.0.1:${mockPort}/receiveGameResult`
  writeFileSync(path.join(ROOT, 'functions/.env.local'),
    `CLASSROOM_CALLBACK_URL=${cb}\nCLASSROOM_ROSTER_URL=http://127.0.0.1:${mockPort}/getCourseRoster\n`)

  // Frontend dev/emulator config (projectId MUST match so the frontend writes to the same
  // emulator namespace the harness reads; connectXxxEmulator overrides every connection).
  writeFileSync(path.join(ROOT, 'frontend/.env.local'),
    [
      'VITE_FIREBASE_API_KEY=dev-placeholder',
      `VITE_FIREBASE_PROJECT_ID=${PROJECT}`,
      `VITE_FIREBASE_AUTH_DOMAIN=${PROJECT}.firebaseapp.com`,
      `VITE_FIREBASE_STORAGE_BUCKET=${PROJECT}.firebasestorage.app`,
      'VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000',
      'VITE_FIREBASE_APP_ID=1:000000000000:web:000000000000000000000000',
      `VITE_FIREBASE_DATABASE_URL=https://${PROJECT}-default-rtdb.firebaseio.com`,
      '',
    ].join('\n'))

  console.log('▶ Building Cloud Functions…')
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })

  console.log('▶ Starting emulators + Vite…')
  const emuLog  = path.join(ROOT, 'playthrough-emu.log')
  const viteLog = path.join(ROOT, 'playthrough-vite.log')
  spawnLogged('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], ROOT, emuLog)
  spawnLogged('npm', ['run', 'dev'], path.join(ROOT, 'frontend'), viteLog)

  console.log('▶ Waiting for all emulators + Vite…')
  await waitHttp('http://localhost:9101/', 'auth emulator')
  await waitHttp('http://localhost:8082/', 'firestore emulator')
  await waitHttp('http://localhost:9002/.json', 'database emulator')
  await waitHttp(`${FUNCTIONS}/health`, 'functions emulator')
  await waitHttp(`${FE}/`, 'Vite dev server')
  await sleep(6000)
  console.log('  Stack ready ✅')
}

function tearDownStack() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ } }
  freePorts()
}

// ── MAIN ────────────────────────────────────────────────────────────────────────

async function main() {
  const mock = await startMockCallback()
  await bringUpStack(mock.port)

  browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO })

  // Warmup — pay the Vite first-transform + first assignRole cold-start before the real run.
  banner('Warmup — priming Vite transform + spinning up function workers')
  {
    const warmOne = async (tag) => {
      const wctx = await browser.newContext()
      const wpage = await wctx.newPage()
      wpage.setDefaultTimeout(30_000)
      let ok = false
      for (let attempt = 1; attempt <= 8 && !ok; attempt++) {
        await wpage.goto(`${FE}/?_pid=warm-${tag}&_gid=warmup-${GID}-${tag}-${attempt}&_session=tab`)
        ok = await wpage.waitForSelector('p:has-text("Your role")', { timeout: 20_000 }).then(() => true).catch(() => false)
        if (!ok) { log('warmup', `${tag} cold-start attempt ${attempt} not ready — retrying`); await sleep(2000) }
      }
      await wctx.close()
      return ok
    }
    if (!(await warmOne('a'))) throw new Error('warmup never reached "Your role" after retries')
    await warmOne('b')
    log('warmup', 'stack warm ✅')
  }

  // ── Launch all students; each drives info → KC → reflection → hold ──
  banner(`Phase 1 — ${PIDS.length} students: info → KC → reflection → hold (single role)`)
  for (const pid of PIDS) {
    const ctx  = await browser.newContext()
    const page = await ctx.newPage()
    page.setDefaultTimeout(60_000)
    students.push({ page, pid })
  }
  // Step 1 — assign roles SEQUENTIALLY (no role_counts lock-timeout contention).
  for (const s of students) await ensureOnRolePage(s.page, s.pid)
  // Step 2 — drive info assert → KC → reflection → hold CONCURRENTLY (per-participant writes only).
  await Promise.all(students.map(async s => {
    const r = await driveSetup(s.page, s.pid)
    s.role = r.role
    s.kc   = r.kc
  }))
  const traderCount = students.filter(s => s.role === 'trader').length
  assert(traderCount === PIDS.length,
    `Roles assigned — all ${PIDS.length} students launch as the single role \`trader\` (got ${traderCount})`)

  // ── KC skeleton: gate seen + passed, both statics rendered, options shuffle per student ──
  assert(students.every(s => s.kc?.sawGate),
    `KC — every student saw the role gate ("What is your role in this market?") and passed on the first click`)
  assert(students.every(s => s.kc?.staticsSeen === KC_FIELDS.length),
    `KC — both placeholder graded questions rendered + submitted for every student (got [${[...new Set(students.map(s => s.kc?.staticsSeen))].join(',')}])`)
  const kcFlat = s => KC_FIELDS.map(f => (s.kc?.orders?.[f] ?? []).join('|')).join(' || ')
  const sA = students.find(s => s.pid === 'stu-3'), sB = students.find(s => s.pid === 'stu-4')
  assert(sA && sB && kcFlat(sA) !== kcFlat(sB),
    `KC — options shuffle per student: stu-3 and stu-4 see a different option order on ≥1 question`)

  // (3) The placeholder role-sheet PDF must RESOLVE over the frontend origin (not 404 / SPA fallback).
  const pdf = await fetch(`${FE}/role-info/spectrum.pdf`)
  const pdfCt = pdf.headers.get('content-type') ?? ''
  assert(pdf.status === 200 && !pdfCt.includes('text/html'),
    `Info doc — /role-info/spectrum.pdf resolves as a real file [${pdf.status} ${pdfCt}]`)
  const bad   = await fetch(`${FE}/role-info/__nope__.pdf`)
  const badCt = bad.headers.get('content-type') ?? ''
  assert(!(bad.status === 200 && !badCt.includes('text/html')),
    `Info doc — resolve check is real (bogus file does NOT resolve as a real file) [${bad.status} ${badCt}]`)

  // ── (4) Instructor dashboard: loads + roster visible ───────────────────────
  banner('Instructor — dashboard loads, roster visible, Generate Code, Match')
  const dctx = await browser.newContext()
  dash = await dctx.newPage()
  dash.setDefaultTimeout(60_000)
  await dash.goto(dashboardUrl())
  await dash.waitForSelector('h1:has-text("Instructor Dashboard — Spectrum")', { timeout: 60_000 })
  const rosterReady = await dash.waitForSelector('table', { timeout: 30_000 }).then(() => true).catch(() => false)
  let rosterNames = 0
  for (const pid of PIDS) if (await dash.locator(`text=${pid}`).count() > 0) rosterNames++
  assert(rosterReady && rosterNames === PIDS.length,
    `Dashboard — roster visible with all ${PIDS.length} participants (found ${rosterNames}/${PIDS.length})`)

  // ── Generate attendance code (dashboard UI), read the value, drive attendees to waiting ──
  await dash.click('button:has-text("Generate Code")')
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await readAttendanceCode(); if (!code) await sleep(500) }
  assert(!!code, `Attendance — "Generate Code" produced a code (${code})`)
  const attendees = students.filter(s => s.pid !== NOSHOW_PID)
  await Promise.all(attendees.map(s => driveToWaiting(s, code)))
  log(NOSHOW_PID, '⊘ TRUE NO-SHOW — completed KC, will NOT attend class')

  // ── (5) Match (dashboard UI) → single-role tiling: 4 attendees → [4] ──
  banner('Match — single-role tiling: 4 attendees → [4] (1 true no-show held back)')
  await dash.waitForSelector('button:has-text("Match Now"):not([disabled])', { timeout: 30_000 })
  await dash.click('button:has-text("Match Now")')
  await pollGroups(gs => gs.length === 1, 30_000)
  const groups0 = await readGroups()
  assert(groups0.length === 1, `Matching — exactly 1 group formed (got ${groups0.length})`)
  const sizes = groups0.map(g => g.traders.length).sort((a, b) => a - b)
  assert(JSON.stringify(sizes) === JSON.stringify([4]),
    `Matching — sizes tile to [4] (4 attendees) (got [${sizes.join(',')}])`)
  const totalPlaced = groups0.reduce((n, g) => n + g.traders.length, 0)
  assert(totalPlaced === ATTEND_PIDS.length,
    `Matching — every ATTENDEE placed, no orphans (${totalPlaced}/${ATTEND_PIDS.length})`)

  const parts = await pollParticipants(
    ps => ps.filter(p => p.group_id).length === ATTEND_PIDS.length,
    30_000,
  )
  const byPid = Object.fromEntries(parts.map(p => [p.id, p]))
  assert(byPid[NOSHOW_PID] && byPid[NOSHOW_PID].role === 'trader' && !byPid[NOSHOW_PID].group_id,
    `Matching — the true no-show ${NOSHOW_PID} has a role but NO group (held out of the match)`)

  const matchedGid = groups0[0].id
  const matchedMembers = students.filter(s => byPid[s.pid]?.group_id === matchedGid)

  // ── (6) matched → MARKET ROOM (no trading UI yet), reload stays coherent ──
  banner('matched → MARKET ROOM (Phase A placeholder), reload stays coherent')
  const roomSample = matchedMembers[0]
  await roomSample.page.waitForSelector('[data-testid="market-room"]', { timeout: 25_000 })
  const roomBody = await bodyText(roomSample.page)
  assert(/in the market/i.test(roomBody),
    `matched — a matched student sees the MARKET ROOM placeholder ("You're in the market")`)
  await roomSample.page.reload()
  const roomBack = await roomSample.page.waitForSelector('[data-testid="market-room"]', { timeout: 25_000 }).then(() => true).catch(() => false)
  assert(roomBack, `matched — reload of a matched student lands back on the market room (no dead end / blank page)`)

  // ══════════════ FINALIZE — Score & Record → participation+KC push (POST + 200) ══════════════
  banner('Finalize — Score & Record → participation+KC grading → grade push (POST + 200)')
  await dash.click('button:has-text("Score & Record")')
  const isResult = r => r.result && typeof r.result === 'object' && typeof r.result.participant_id === 'string'
  const start = Date.now()
  while (mock.received.filter(isResult).length < PIDS.length && Date.now() - start < 30_000) await sleep(500)
  const pushed = mock.received.filter(isResult)
  log('push', `mock received ${mock.received.length} request(s); ${pushed.length} are GameResult POSTs`)
  assert(pushed.length >= PIDS.length,
    `Grade push — the classroom callback received ${pushed.length} GameResult POSTs (one per participant; push fired)`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.result.normalized_score === 'number' || r.result.normalized_score === null),
    `Grade push — every pushed GameResult carries a normalized_score field`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.auth === 'string' && r.auth.startsWith('Bearer ')),
    `Grade push — every push is authenticated with the callback Bearer secret`)

  const pushedById  = Object.fromEntries(pushed.map(r => [r.result.participant_id, r.result]))
  const pushedPids  = new Set(pushed.map(r => r.result.participant_id))
  assert(PIDS.every(p => pushedPids.has(p)) && pushedPids.size === PIDS.length,
    `Grade push — EVERY participant lands in the payload, nobody dropped: ${pushedPids.size}/${PIDS.length} (incl. the no-show)`)

  // knowledge_check_score rides as its OWN 0–1 field — real varying values.
  assert(pushed.every(r => r.result.knowledge_check_score === null ||
      (typeof r.result.knowledge_check_score === 'number' && r.result.knowledge_check_score >= 0 && r.result.knowledge_check_score <= 1)),
    `Grade push — knowledge_check_score rides as its own 0–1 field on every record`)
  assert(pushedById[KC_HALF_PID]?.knowledge_check_score === 0.5 && pushedById[KC_ZERO_PID]?.knowledge_check_score === 0,
    `Grade push — the real KC values reach the gradebook (1/2 → 0.5, 0/2 → 0) [got ${pushedById[KC_HALF_PID]?.knowledge_check_score} / ${pushedById[KC_ZERO_PID]?.knowledge_check_score}]`)

  // PORTFOLIO / MARKET VALUE IS NOT IN THE PAYLOAD in ANY form — never graded.
  const valueLeak = pushed.find(r => {
    const res = r.result
    if ('portfolio_value' in res || 'market_value' in res || 'value' in res || 'raw_score' in res) return true
    return Object.keys(res.details ?? {}).length !== 0
  })
  assert(!valueLeak,
    `Grade push — NO portfolio/market value in the payload (no portfolio_value/market_value/value/raw_score; details empty) — value never graded`)

  // ── Participation: every PRESENT trader has the IDENTICAL flat raw_score → z 0 ──
  const partsFinal  = await readParticipants()
  const byPidFinal  = Object.fromEntries(partsFinal.map(p => [p.id, p]))
  const present     = partsFinal.filter(p => p.group_id)          // the 4 matched
  const rawSet      = new Set(present.map(p => p.raw_score))
  assert(present.length === ATTEND_PIDS.length && rawSet.size === 1 && present.every(p => p.raw_score === 1),
    `Scoring — every present trader has the IDENTICAL flat participation raw_score (=1) [${[...rawSet].join(',')}]`)
  assert(present.every(p => p.normalized_score === 0),
    `Scoring — degenerate single-role pool: every present trader normalizes to 0 (SD=0 guard) [${[...new Set(present.map(p => p.normalized_score))].join(',')}]`)

  // ── The TRUE no-show: raw null / z −2 / status no_show, EXCLUDED but delivered ──
  const noShow = byPidFinal[NOSHOW_PID]
  assert(noShow && noShow.raw_score == null && noShow.normalized_score === -2,
    `Scoring — the TRUE no-show ${NOSHOW_PID} (never attended): raw_score null, normalized_score −2 [raw=${noShow?.raw_score}, z=${noShow?.normalized_score}]`)
  assert(pushedById[NOSHOW_PID]?.normalized_score === -2 && pushedById[NOSHOW_PID]?.status === 'no_show',
    `Grade push — the true no-show is delivered with normalized_score −2 / status no_show`)

  // ── KC values finalize correctly on the participant docs ──
  const kcOf = pid => byPidFinal[pid]?.knowledge_check_score
  assert(kcOf(KC_HALF_PID) === 0.5,
    `KC score — the 1-of-2 student ${KC_HALF_PID} finalizes with knowledge_check_score 0.5 (got ${kcOf(KC_HALF_PID)})`)
  assert(kcOf(KC_ZERO_PID) === 0,
    `KC score — the all-wrong student ${KC_ZERO_PID} STILL finalizes, score 0 (a wrong answer never blocks) (got ${kcOf(KC_ZERO_PID)})`)
  assert(kcOf('stu-3') === 1,
    `KC score — an all-correct student (stu-3) finalizes with score 1.0 (got ${kcOf('stu-3')})`)

  // ── Reports page loads for the skeleton (per-student participation + KC) ──
  banner('Reports — instructor Reports page loads (per-student participation + KC)')
  await dash.goto(`${FE}/reports?_dev_game_instance_id=${encodeURIComponent(GID)}&_session=tab`)
  await dash.waitForSelector('h2:has-text("Reports — Spectrum")', { timeout: 30_000 })
  const reportsLoaded = await dash.getByText(/finalized/i).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
  assert(reportsLoaded, `Reports — the per-student report tile loads for the finalized skeleton instance`)
}

// ── Entry point ─────────────────────────────────────────────────────────────────

;(async () => {
  try {
    await main()
  } catch (err) {
    FAIL++
    console.error('\n✗ FATAL:', err?.message ?? err)
    try { await dumpDiagnostics('fatal error') } catch { /* best effort */ }
  } finally {
    banner(`RESULT — ${PASS}/${PASS + FAIL} green${FAIL ? `  (${FAIL} FAILED)` : ''}`)
    await new Promise(res => setTimeout(res, 150))
    if (browser) { try { await browser.close() } catch { /* */ } }
    tearDownStack()
    process.exit(FAIL ? 1 : 0)
  }
})()
