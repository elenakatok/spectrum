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

// Slice 0: grouping needs N (even, 14–26) present traders to form N teams. N=14 (min).
// 5 students go through the REAL UI (all launch + KC assertions live here); stu-5 is the
// TRUE NO-SHOW (launches + completes KC, never attends). 10 more are SEEDED as present
// fillers so grouping has 14 present traders. 15 participants total (14 present + 1 no-show).
const N_TEAMS     = 14
const UI_PIDS     = Array.from({ length: 5 }, (_, i) => `stu-${i + 1}`)
const NOSHOW_PID  = UI_PIDS[UI_PIDS.length - 1]                     // stu-5
const UI_ATTEND   = UI_PIDS.filter(p => p !== NOSHOW_PID)          // stu-1..4 attend via UI
const FILLER_PIDS = Array.from({ length: 10 }, (_, i) => `stu-${i + 6}`) // stu-6..15 (seeded)
const ALL_PIDS    = [...UI_PIDS, ...FILLER_PIDS]                   // 15 total
const PRESENT_PIDS = [...UI_ATTEND, ...FILLER_PIDS]                // 14 present → grouped

// ── KC: single-option gate + 13 graded statics (Spectrum_KC_Questions_v3.md) ────
// For each static, a UNIQUE substring of the CORRECT option label and of a WRONG option
// label — the drive selects by TEXT (hasText, case-insensitive substring on <label> only), so
// it is immune to the per-student option shuffle AND independent of letter position. Verbatim
// from gameDefinition.ts prepDefaults. Answer key: C·A·B·B·B·B·B·B·B·B·B·B·C.
const KC_FIELDS = ['kc_q1', 'kc_q2', 'kc_q3', 'kc_q4', 'kc_q5', 'kc_q6', 'kc_q7', 'kc_q8', 'kc_q9', 'kc_q10', 'kc_q11', 'kc_q12', 'kc_q13']
const KC_CORRECT = {
  kc_q1: 'sum value of your license',
  kc_q2: '100', kc_q3: '250', kc_q4: '$90',
  kc_q5: 'different chart, and your chart is private',
  kc_q6: 'not official until it is reported',
  kc_q7: 'privately enters their password to confirm',
  kc_q8: 'first-price sealed-bid auction with a hard close',
  kc_q9: 'no trade is recorded after the clock expires',
  kc_q10: 'roughly five to eight',
  kc_q11: 'wide gap between the highest and second-highest',
  kc_q12: 'joint value creation through collaboration',
  kc_q13: 'not mutually exclusive',
}
const KC_WRONG = {
  kc_q1: 'the number of licenses you hold',
  kc_q2: '610', kc_q3: '690', kc_q4: '$510',
  kc_q5: 'posted on the market platform',
  kc_q6: 'handshake agreement counts',
  kc_q7: 'freely share passwords',
  kc_q8: 'Vickrey',
  kc_q9: 'instructor extends the market',
  kc_q10: 'no upper limit',
  kc_q11: 'value the asset identically',
  kc_q12: 'standardized commodity',
  kc_q13: 'Confidentiality favors auctions',
}
// Answer plan by pid: stu-1 → Q1–Q9 correct, Q10–Q13 wrong (9/13); stu-2 → 0/13; others → 13/13.
const KC_HALF_PID = UI_PIDS[0]   // stu-1
const KC_ZERO_PID = UI_PIDS[1]   // stu-2
const KC_HALF_CORRECT = KC_FIELDS.slice(0, 9)   // kc_q1 … kc_q9
const KC_HALF_SCORE = KC_HALF_CORRECT.length / KC_FIELDS.length   // 9/13
function kcPlanFor(pid) {
  if (pid === KC_HALF_PID) return new Set(KC_HALF_CORRECT)
  if (pid === KC_ZERO_PID) return new Set()
  return new Set(KC_FIELDS)     // everyone else answers all 13 correctly
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

// ── Slice 0 grouping reads (truth is rules-denied; owner Bearer bypasses rules) ──
async function readTruthDocs() {
  const groups = await fsGetDocs('groups')
  const out = []
  for (const g of groups) {
    const gid = g.name.split('/').pop()
    const t = await fsGetDoc(`groups/${gid}/truth/team`)
    if (t?.fields) out.push({
      group_id:        gid,
      team_number:     numVal(t.fields.team_number),
      password:        strVal(t.fields.password),
      cash:            numVal(t.fields.cash),
      portfolio_value: numVal(t.fields.portfolio_value),
    })
  }
  return out
}
async function readLicenses() {
  const docs = await fsGetDocs('licenses')
  return docs.map(d => ({
    id:         d.name.split('/').pop(),
    owner_team: numVal(d.fields?.owner_team),
    region:     strVal(d.fields?.region),
  }))
}
async function readMarketState() {
  const doc = await fsGetDoc('market/state')
  if (!doc?.fields) return null
  return {
    status:                 strVal(doc.fields.status),
    num_teams:              numVal(doc.fields.num_teams),
    num_regions:            numVal(doc.fields.num_regions),
    efficient_market_value: numVal(doc.fields.efficient_market_value),
  }
}
async function readParticipantDoc(pid) {
  const d = await fsGetDoc(`participants/${pid}`)
  if (!d?.fields) return null
  return {
    team_number:          numVal(d.fields.team_number),
    team_password:        strVal(d.fields.team_password),
    team_portfolio_value: numVal(d.fields.team_portfolio_value),
    group_id:             strVal(d.fields.group_id),
  }
}
async function pollMarketStatus(want, maxMs = 20_000) {
  const start = Date.now()
  let ms = await readMarketState()
  while (Date.now() - start < maxMs) {
    ms = await readMarketState()
    if (ms?.status === want) return ms
    await sleep(600)
  }
  return ms
}
// Append present filler traders (clear:false → merges presence, keeps UI students).
async function seedFillers() {
  const res = await fetch(`${FUNCTIONS}/seedMatchTest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      game_instance_id: GID, clear: false,
      participants: FILLER_PIDS.map(id => ({ id, role: 'trader', present: true })),
    }),
  })
  return res.ok
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

  // ── Launch the UI students; each drives info → KC → reflection → hold ──
  banner(`Phase 1 — ${UI_PIDS.length} UI students: info → KC → reflection → hold (single role)`)
  for (const pid of UI_PIDS) {
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
  assert(traderCount === UI_PIDS.length,
    `Roles assigned — all ${UI_PIDS.length} UI students launch as the single role \`trader\` (got ${traderCount})`)

  // ── KC: gate seen + passed, all 13 statics rendered + submitted, options shuffle per student ──
  assert(students.every(s => s.kc?.sawGate),
    `KC — every student saw the role gate ("What is your role in this market?") and passed on the first click`)
  assert(students.every(s => s.kc?.staticsSeen === KC_FIELDS.length),
    `KC — all ${KC_FIELDS.length} graded questions rendered + submitted for every UI student (render+submit end-to-end) (got [${[...new Set(students.map(s => s.kc?.staticsSeen))].join(',')}])`)
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
  for (const pid of UI_PIDS) if (await dash.locator(`text=${pid}`).count() > 0) rosterNames++
  assert(rosterReady && rosterNames === UI_PIDS.length,
    `Dashboard — roster visible with all ${UI_PIDS.length} UI participants (found ${rosterNames}/${UI_PIDS.length})`)

  // ── Generate attendance code (dashboard UI), read the value, drive attendees to waiting ──
  await dash.click('button:has-text("Generate Code")')
  let code = null
  for (let i = 0; i < 20 && !code; i++) { code = await readAttendanceCode(); if (!code) await sleep(500) }
  assert(!!code, `Attendance — "Generate Code" produced a code (${code})`)
  const attendees = students.filter(s => s.pid !== NOSHOW_PID)
  await Promise.all(attendees.map(s => driveToWaiting(s, code)))
  log(NOSHOW_PID, '⊘ TRUE NO-SHOW — completed KC, will NOT attend class')

  // ── Seed 10 present filler traders so grouping has 14 present (UI drove only 4) ──
  banner('Seed fillers — 10 present traders (stu-6..15) so N=14 has 14 present')
  assert(await seedFillers(),
    `Seed — 10 filler present traders appended (clear:false; UI students' presence preserved)`)

  // ── (5) GROUPING — instructor two-step: Set N=14 → Group Participants (NOT Match Now) ──
  banner('Grouping — instructor sets N=14, Group Participants → 14 teams generated server-side')
  await dash.waitForSelector('[data-testid="group-participants"]', { timeout: 30_000 })
  await dash.fill('[data-testid="num-teams-input"]', String(N_TEAMS))
  await dash.click('[data-testid="set-num-teams"]')
  await dash.click('[data-testid="group-participants"]')
  const groupsG = await pollGroups(gs => gs.length === N_TEAMS, 40_000)
  assert(groupsG.length === N_TEAMS, `Grouping — exactly ${N_TEAMS} teams formed (got ${groupsG.length})`)

  const truth = await readTruthDocs()
  assert(truth.length === N_TEAMS, `Grouping — ${N_TEAMS} private (rules-denied) truth docs written (got ${truth.length})`)
  const teamNums = [...new Set(truth.map(t => t.team_number))].sort((a, b) => a - b)
  assert(JSON.stringify(teamNums) === JSON.stringify(Array.from({ length: N_TEAMS }, (_, i) => i + 1)),
    `Grouping — team numbers are exactly 1..${N_TEAMS} (got [${teamNums.join(',')}])`)

  // Cash conservation (invariant 7): Σ team cash === N × startingCash.
  const totalCash = truth.reduce((n, t) => n + (t.cash ?? 0), 0)
  assert(totalCash === N_TEAMS * 1000,
    `Grouping — CASH CONSERVATION: Σ team cash = ${totalCash} === ${N_TEAMS}×1000 (invariant 7)`)
  // Every team opens at portfolio value 1400.
  assert(truth.every(t => t.portfolio_value === 1400),
    `Grouping — every team opens at portfolio value 1400 [${[...new Set(truth.map(t => t.portfolio_value))].join(',')}]`)
  // Team 7's password is 'Strauss' (positional list) — the named-assertion leg 3 end-to-end.
  const t7 = truth.find(t => t.team_number === 7)
  assert(t7?.password === 'Strauss',
    `Grouping — team 7's password is 'Strauss' (positional list, server-generated) [got ${t7?.password}]`)

  // Endowment / one-owner: 4×N licenses, unique ids, each owned by a team in 1..N.
  const licenses = await readLicenses()
  assert(licenses.length === 4 * N_TEAMS,
    `Grouping — ${4 * N_TEAMS} licenses generated (M regions × 8) (got ${licenses.length})`)
  const licIds = new Set(licenses.map(l => l.id))
  assert(licIds.size === licenses.length && licenses.every(l => l.owner_team >= 1 && l.owner_team <= N_TEAMS),
    `Grouping — every license has exactly ONE owner, all in teams 1..${N_TEAMS} (invariant: one owner)`)

  // Market state: grouped (clock NOT started), N teams, N/2 regions, EMV 24850 (verified).
  const msGrouped = await readMarketState()
  assert(msGrouped?.status === 'grouped' && msGrouped.num_teams === N_TEAMS && msGrouped.num_regions === N_TEAMS / 2,
    `Grouping — market status 'grouped' (clock NOT started), ${N_TEAMS} teams, ${N_TEAMS / 2} regions [${msGrouped?.status}, ${msGrouped?.num_teams}, ${msGrouped?.num_regions}]`)
  assert(msGrouped?.efficient_market_value === 24850,
    `Grouping — Efficient Market Value at N=14 = 24850 (closed form, server-computed) [got ${msGrouped?.efficient_market_value}]`)

  // The no-show is held out of grouping; all present traders placed.
  const parts = await pollParticipants(ps => ps.filter(p => p.group_id).length === PRESENT_PIDS.length, 30_000)
  const byPid = Object.fromEntries(parts.map(p => [p.id, p]))
  assert(byPid[NOSHOW_PID] && byPid[NOSHOW_PID].role === 'trader' && !byPid[NOSHOW_PID].group_id,
    `Grouping — the true no-show ${NOSHOW_PID} has a role but NO team (held out)`)
  const placed = parts.filter(p => p.group_id).length
  assert(placed === PRESENT_PIDS.length,
    `Grouping — all ${PRESENT_PIDS.length} present traders placed into teams, no orphans (${placed}/${PRESENT_PIDS.length})`)

  // ── (6) STUDENT DOSSIER — a grouped UI student lands in the market room with their team ──
  banner('Market room — a grouped student sees Team #, password, Portfolio Value 1400, synergy table')
  const dossier = students.find(s => s.pid === UI_ATTEND[0]) // stu-1
  await dossier.page.waitForSelector('[data-testid="market-room"]', { timeout: 30_000 })
  await dossier.page.waitForSelector('[data-testid="team-number"]', { timeout: 15_000 })
  const expected = await readParticipantDoc(dossier.pid)
  const domTeam = (await dossier.page.locator('[data-testid="team-number"]').innerText()).trim()
  const domPass = (await dossier.page.locator('[data-testid="team-password"]').innerText()).trim()
  const domPV   = (await dossier.page.locator('[data-testid="portfolio-value"]').innerText()).trim()
  assert(expected?.team_number != null && domTeam.includes(String(expected.team_number)),
    `Market room — dossier shows the student's team number (Team ${expected?.team_number}) [DOM "${domTeam}"]`)
  assert(domPass.length > 0 && domPass === expected?.team_password,
    `Market room — dossier shows the team password served from the student's OWN doc [DOM "${domPass}"]`)
  assert(/1,?400/.test(domPV),
    `Market room — dossier shows Portfolio Value 1400 [DOM "${domPV}"]`)
  const synergyRows = await dossier.page.locator('[data-testid="synergy-table"] tbody tr').count()
  assert(synergyRows === N_TEAMS / 2,
    `Market room — private synergy table renders one row per region (${N_TEAMS / 2}) [got ${synergyRows}]`)
  assert(expected?.team_portfolio_value === 1400,
    `Market room — the student's own participant doc carries team_portfolio_value 1400 (server-stamped)`)
  await dossier.page.reload()
  const back = await dossier.page.waitForSelector('[data-testid="market-room"]', { timeout: 25_000 }).then(() => true).catch(() => false)
  assert(back, `Market room — reload lands back on the market room (no dead end / blank page)`)

  // ── (7) START MARKET — the second button opens the market and starts the clock ──
  banner('Start Market — status grouped → open (clock starts)')
  await dash.waitForSelector('[data-testid="start-market"]', { timeout: 20_000 })
  await dash.click('[data-testid="start-market"]')
  const msOpen = await pollMarketStatus('open', 20_000)
  assert(msOpen?.status === 'open',
    `Start Market — market status flips 'grouped' → 'open' (clock started) [${msOpen?.status}]`)

  // ══════════════ FINALIZE — Score & Record → participation+KC push (POST + 200) ══════════════
  banner('Finalize — Score & Record → participation+KC grading → grade push (POST + 200)')
  await dash.click('button:has-text("Score & Record")')
  const isResult = r => r.result && typeof r.result === 'object' && typeof r.result.participant_id === 'string'
  const start = Date.now()
  while (mock.received.filter(isResult).length < ALL_PIDS.length && Date.now() - start < 45_000) await sleep(500)
  const pushed = mock.received.filter(isResult)
  log('push', `mock received ${mock.received.length} request(s); ${pushed.length} are GameResult POSTs`)
  assert(pushed.length >= ALL_PIDS.length,
    `Grade push — the classroom callback received ${pushed.length} GameResult POSTs (one per participant; push fired)`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.result.normalized_score === 'number' || r.result.normalized_score === null),
    `Grade push — every pushed GameResult carries a normalized_score field`)
  assert(pushed.length > 0 && pushed.every(r => typeof r.auth === 'string' && r.auth.startsWith('Bearer ')),
    `Grade push — every push is authenticated with the callback Bearer secret`)

  const pushedById  = Object.fromEntries(pushed.map(r => [r.result.participant_id, r.result]))
  const pushedPids  = new Set(pushed.map(r => r.result.participant_id))
  assert(ALL_PIDS.every(p => pushedPids.has(p)) && pushedPids.size === ALL_PIDS.length,
    `Grade push — EVERY participant lands in the payload, nobody dropped: ${pushedPids.size}/${ALL_PIDS.length} (incl. the no-show)`)

  // knowledge_check_score rides as its OWN 0–1 field — real varying values.
  assert(pushed.every(r => r.result.knowledge_check_score === null ||
      (typeof r.result.knowledge_check_score === 'number' && r.result.knowledge_check_score >= 0 && r.result.knowledge_check_score <= 1)),
    `Grade push — knowledge_check_score rides as its own 0–1 field on every record`)
  const halfScore = pushedById[KC_HALF_PID]?.knowledge_check_score
  assert(typeof halfScore === 'number' && Math.abs(halfScore - KC_HALF_SCORE) < 1e-9 && pushedById[KC_ZERO_PID]?.knowledge_check_score === 0,
    `Grade push — the real KC values reach the gradebook keyed to the answer key (9/13 → ${KC_HALF_SCORE.toFixed(4)}, 0/13 → 0) [got ${halfScore} / ${pushedById[KC_ZERO_PID]?.knowledge_check_score}]`)
  // A student who answered all 13 correctly scores a clean 1.0 (denominator = 13 graded statics).
  const fullPid = UI_PIDS.find(p => p !== KC_HALF_PID && p !== KC_ZERO_PID)
  assert(pushedById[fullPid]?.knowledge_check_score === 1,
    `Grade push — an all-correct student scores 13/13 → 1.0 [${fullPid} got ${pushedById[fullPid]?.knowledge_check_score}]`)

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
  const present     = partsFinal.filter(p => p.group_id)          // the 14 grouped
  const rawSet      = new Set(present.map(p => p.raw_score))
  assert(present.length === PRESENT_PIDS.length && rawSet.size === 1 && present.every(p => p.raw_score === 1),
    `Scoring — every present trader has the IDENTICAL flat participation raw_score (=1), ${present.length}/${PRESENT_PIDS.length} [${[...rawSet].join(',')}]`)
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
  assert(typeof kcOf(KC_HALF_PID) === 'number' && Math.abs(kcOf(KC_HALF_PID) - KC_HALF_SCORE) < 1e-9,
    `KC score — the 9-of-13 student ${KC_HALF_PID} finalizes with knowledge_check_score ${KC_HALF_SCORE.toFixed(4)} (got ${kcOf(KC_HALF_PID)})`)
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
