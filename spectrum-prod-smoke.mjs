/**
 * Spectrum SLICE 3+4 — PRODUCTION smoke + student-tab & instructor-view screenshots.
 *
 * Drives the DEPLOYED spectrum.mygames.live against the DEPLOYED callables, then captures the
 * five student tabs AND the five Slice-4 instructor views. Faithful path (no emulator): admin-seed
 * 14 test participants on a course-ABC test instance to a groupable state, drive the REAL instructor
 * grouping panel + Start Market in a real browser (→ real groupParticipants/startMarket), do one real
 * deal (→ real executeDeal), load a grouped student via a real classroom-signed JWT (→ real assignRole
 * → getTeamState/History/Directory/getAuctionState), screenshot all five student tabs, then open the
 * instructor /market route (→ real getLeaderboard/getTransactionGraph/getRoster) and screenshot all
 * five projector views, then RESTORE the instance to bare.
 *
 * Part 2 (populated graph): before capture, seedActivity() drives a realistic spread via the REAL
 * deployed callables — several deals (distinct regions/prices), a settled auction, a swap, a
 * 2-license block, and one auction left OPEN mid-flight — so the graph (○ deals / △ auction / ◇ swap),
 * the blue ownership block, the 🔒 under-auction marker and the non-zero dashboard progress readout
 * are all exercised. spreadTimeline() then spreads the (real) transactions' timestamps across the
 * elapsed window and backdates opened_at so the X = elapsed-minutes axis reads clearly (we can't wait
 * 40 real minutes; prices/regions/types stay real — only `at` is adjusted for the screenshot).
 *
 * Reads/writes ONLY a course-ABC test instance; signs tokens with the classroom key (same as the
 * launcher). Requires ADC (gcloud application-default) + classroom/scripts/game-jwt-private.pem.
 *
 *   node spectrum-prod-smoke.mjs        (HEADED=1 to watch; KEEP=1 to skip the restore)
 */
import { chromium } from 'playwright'
import admin from './functions/node_modules/firebase-admin/lib/index.js'
import jwt from './functions/node_modules/jsonwebtoken/index.js'
import { readFileSync, mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const PROJECT   = 'spectrum-mygames-live'
const GID       = process.env.GID ?? '9gRCTOko51rvLerHlXzX'   // course-ABC test instance (14 bare participants)
const BASE      = 'https://spectrum.mygames.live'
const RTDB_URL  = `https://${PROJECT}-default-rtdb.firebaseio.com`
const KEY_PATH  = path.resolve(ROOT, '../../classroom/scripts/game-jwt-private.pem')
const N_TEAMS   = 14
const HEADED    = process.env.HEADED === '1'
const KEEP      = process.env.KEEP === '1'
const SHOT_DIR  = path.resolve(ROOT, 'prod-smoke-shots')

let PASS = 0, FAIL = 0
const ok  = (c, m) => { if (c) { PASS++; console.log(`  ✅ ${m}`) } else { FAIL++; console.log(`  ❌ ${m}`) }; return c }
const log = (m) => console.log('  · ' + m)

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT, databaseURL: RTDB_URL })
const db = admin.firestore(), rtdb = admin.database()
const inst = db.collection('game_instances').doc(GID)
const KEY = readFileSync(KEY_PATH, 'utf8')

// classroom-signed JWT (only iss/kid/role/game_instance_id/participant_id matter to the game).
function signToken(role, participantId, name) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({
    iss: 'classroom.mygames.live', sub: participantId, iat: now, exp: now + 900,
    participant_id: participantId, name, course_id: 'smoke', session_id: 'smoke',
    game_instance_id: GID, game_config_id: null, role,
    classroom_callback_url: 'https://classroom.mygames.live/api/game-results',
    callback_secret_id: 'spectrum_v1',
  }, KEY, { algorithm: 'RS256', keyid: 'classroom-v1' })
}

// Call a DEPLOYED callable directly (onCall v2 over HTTP, same alias the browser SDK uses).
// Student/instructor auth travels as a classroom JWT in data.token — the callables accept it
// (the path assignRole bootstraps on); allUsers invoker means no IAM, and a node fetch is not
// subject to browser CORS. Lets us seed a realistic spread of activity fast, no admin ledger writes.
async function callProd(name, data) {
  const res = await fetch(`https://us-central1-${PROJECT}.cloudfunctions.net/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.error) throw new Error(`${name} (${res.status}): ${JSON.stringify(j.error ?? j)}`)
  return j.result
}

// Seed a realistic spread so the instructor Transaction Graph is captured POPULATED: several deals
// (distinct regions/prices), a settled auction (a △ point), a swap (the price-less strip), a
// 2-license block (a blue ownership cell) and an auction left OPEN mid-flight (the 🔒 marker).
// Every trade is a REAL deployed callable; only the block + the timestamp spread are visual seeds.
async function seedActivity(pids, teamOf, pwOf, instrToken) {
  const pidOfTeam   = (t) => pids.find((p) => teamOf.get(p) === t)
  const tokenOfTeam = (t) => signToken('student', pidOfTeam(t), `Trader T${t}`)
  const freeRegionOf = async (t) => {
    const ls = (await inst.collection('licenses').where('owner_team', '==', t).get()).docs
      .map((d) => d.data()).filter((l) => l.under_auction == null)
    return ls[0]?.region ?? null
  }
  const done = []

  // Deals — distinct (seller, buyer, region, price). Team 1's deal is the browser-UI one.
  for (const [s, b, price] of [[3, 4, 340], [5, 6, 175], [7, 8, 415]]) {
    const region = await freeRegionOf(s)
    if (!region) continue
    await callProd('executeDeal', { token: tokenOfTeam(s), region, quantity: 1, price, buyerTeam: b, buyerPassword: pwOf.get(b) })
    done.push(`deal T${s}→T${b} ${region} $${price}`)
  }
  // Swap — team 9 ↔ team 10 (price-less strip).
  const r9 = await freeRegionOf(9), r10 = await freeRegionOf(10)
  if (r9 && r10 && r9 !== r10) {
    await callProd('executeSwap', { token: tokenOfTeam(9), regionX: r9, quantityX: 1, regionY: r10, quantityY: 1, partnerTeam: 10, partnerPassword: pwOf.get(10) })
    done.push(`swap T9(${r9})↔T10(${r10})`)
  }
  // Settled auction — team 11 sells, team 12 bids, instructor force-settles now (a △ point).
  const r11 = await freeRegionOf(11)
  if (r11) {
    const a = await callProd('createAuction', { token: tokenOfTeam(11), region: r11, quantity: 1, reserve: 0 })
    await callProd('placeBid', { token: tokenOfTeam(12), auction_id: a.auction_id, amount: 305 })
    await callProd('settleAuction', { token: instrToken, auction_id: a.auction_id })
    done.push(`auction T11→T12 ${r11} $305 settled`)
  }
  // Mid-flight auction — team 13, left OPEN so the ownership board shows 🔒 at capture time.
  const r13 = await freeRegionOf(13)
  if (r13) {
    await callProd('createAuction', { token: tokenOfTeam(13), region: r13, quantity: 1, reserve: 0 })
    done.push(`auction T13 ${r13} OPEN`)
  }
  // Block — give team 1 a 2nd license in one region (a blue ownership cell). Visual seed via
  // admin (like the participant seed); wiped by restore. Deals ran first, so nothing in-flight moves.
  const pool = (await inst.collection('licenses').get()).docs
    .map((d) => ({ ref: d.ref, region: d.data().region, auc: d.data().under_auction }))
    .filter((l) => l.auc == null)
  const byRegion = new Map()
  for (const l of pool) { const a = byRegion.get(l.region) ?? []; a.push(l); byRegion.set(l.region, a) }
  const blockRegion = [...byRegion.entries()].find(([, a]) => a.length >= 2)?.[0]
  if (blockRegion) {
    const b = db.batch()
    for (const l of byRegion.get(blockRegion).slice(0, 2)) b.update(l.ref, { owner_team: 1 })
    await b.commit()
    done.push(`block T1 ${blockRegion}×2`)
  }
  log('seeded: ' + done.join(' · '))
}

// Spread transaction timestamps across a ~38-min elapsed window and backdate opened_at, so the
// graph's X = elapsed-minutes axis is visibly exercised (we can't wait 38 real minutes). Prices,
// regions and types are all REAL — only `at` is adjusted, purely for the screenshot.
async function spreadTimeline() {
  const openedAt = admin.firestore.Timestamp.fromMillis(Date.now() - 42 * 60000)
  await inst.collection('market').doc('state').update({ opened_at: openedAt })
  const txs = (await inst.collection('transactions').get()).docs
    .sort((a, b) => (a.data().at?.toMillis?.() ?? 0) - (b.data().at?.toMillis?.() ?? 0))
  if (txs.length === 0) return
  const startMs = openedAt.toMillis() + 4 * 60000, endMs = Date.now() - 3 * 60000
  const batch = db.batch()
  txs.forEach((d, i) => {
    const t = txs.length === 1 ? (startMs + endMs) / 2 : startMs + ((endMs - startMs) * i) / (txs.length - 1)
    batch.update(d.ref, { at: admin.firestore.Timestamp.fromMillis(Math.round(t)) })
  })
  await batch.commit()
}

// Fields WE add to a participant (seed + grouping) — deleted on restore to leave the instance bare.
const SEEDED_FIELDS = ['role', 'role_assigned_at', 'attendance_confirmed_at', 'confirmed_ready_at',
  'group_id', 'is_lead', 'team_number', 'team_password', 'team_synergy', 'team_endowment_regions',
  'team_license_ids', 'team_cash', 'team_license_value', 'team_portfolio_value']

async function seedGroupable(pids) {
  const now = admin.firestore.FieldValue.serverTimestamp()
  const presence = {}
  const batch = db.batch()
  for (const pid of pids) {
    batch.set(inst.collection('participants').doc(pid),
      { role: 'trader', prep_status: 'complete', attendance_confirmed_at: now, confirmed_ready_at: now }, { merge: true })
    presence[pid] = { online: true, last_seen: Date.now() }
  }
  await batch.commit()
  await rtdb.ref(`presence/${GID}`).set(presence)
}

async function restore(pids) {
  log('restoring the instance to bare…')
  for (const sub of ['groups', 'licenses', 'transactions', 'auctions']) await db.recursiveDelete(inst.collection(sub))
  await inst.collection('market').doc('state').delete().catch(() => {})
  await db.recursiveDelete(inst.collection('role_counts'))
  const del = admin.firestore.FieldValue.delete()
  const batch = db.batch()
  for (const pid of pids) batch.set(inst.collection('participants').doc(pid),
    Object.fromEntries(SEEDED_FIELDS.map((f) => [f, del])), { merge: true })
  await batch.commit()
  await rtdb.ref(`presence/${GID}`).remove()
}

async function shoot(page, tab, label) {
  await page.locator(`[data-testid="tab-${tab}"]`).click().catch(() => {})
  // Wait out the callable-backed loading states (getTeamHistory/getTeamsDirectory) before capture.
  for (let i = 0; i < 24; i++) {
    const t = await page.locator('[data-testid="market-room"]').innerText().catch(() => '')
    if (!/Loading (history|teams)…/.test(t)) break
    await sleep(750)
  }
  await sleep(2000)
  const file = path.join(SHOT_DIR, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  log(`  📸 ${tab} → ${file}`)
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  console.log(`\n=== Spectrum PROD smoke → ${BASE} (instance ${GID}) ===\n`)
  const pids = (await inst.collection('participants').get()).docs.map((d) => d.id)
  ok(pids.length === N_TEAMS, `test instance has ${pids.length} participants`)

  log('seeding 14 participants to groupable (role/attendance/presence)…')
  await seedGroupable(pids)
  // Verify eligibility the way groupParticipants checks it (role trader + attendance + presence).
  const ps = await inst.collection('participants').get()
  const elig = ps.docs.filter((d) => d.data().role === 'trader' && d.data().attendance_confirmed_at != null).length
  const pres = Object.keys((await rtdb.ref(`presence/${GID}`).once('value')).val() ?? {}).length
  ok(elig >= N_TEAMS && pres >= N_TEAMS, `eligibility: ${elig} trader+attended, ${pres} present in RTDB`)

  const browser = await chromium.launch({ headless: !HEADED })
  try {
    // ── Instructor: real grouping panel + Start Market against prod hosting ──
    const instrToken = signToken('instructor', 'smoke-instr', 'Smoke Instructor')
    const instr = await browser.newPage()
    await instr.goto(`${BASE}/dashboard?token=${instrToken}&game_instance_id=${GID}&_session=tab`)
    await instr.locator('[data-testid="num-teams-input"]').waitFor({ timeout: 40_000 })
    await instr.locator('[data-testid="num-teams-input"]').fill(String(N_TEAMS))
    await instr.locator('[data-testid="set-num-teams"]').click()
    const statusNow = async () => (await inst.collection('market').doc('state').get()).data()?.status
    // Retry the group click until Firestore confirms — early clicks race the instructor sign-in
    // (signInWithCustomToken), so the first callable(s) go out with no Bearer ("Missing token").
    let grouped = false
    for (let i = 0; i < 18 && !grouped; i++) {
      await instr.locator('[data-testid="group-participants"]').click().catch(() => {})
      await sleep(3000)
      const st = await statusNow()
      grouped = st === 'grouped' || st === 'open'
    }
    await instr.screenshot({ path: path.join(SHOT_DIR, '_dashboard.png'), fullPage: true }).catch(() => {})
    ok(grouped, 'groupParticipants completed → status grouped')
    // Same retry for Start Market.
    let open = (await statusNow()) === 'open'
    for (let i = 0; i < 12 && !open; i++) {
      await instr.locator('[data-testid="start-market"]').click().catch(() => {})
      await sleep(3000)
      open = (await statusNow()) === 'open'
    }
    const ms = (await inst.collection('market').doc('state').get()).data()
    ok(ms?.status === 'open' && ms?.num_teams === N_TEAMS, `grouped + market OPEN (${ms?.num_teams} teams, ${ms?.num_regions} regions, efficient value ${ms?.efficient_market_value})`)
    if (ms?.status !== 'open') throw new Error('market did not open — aborting before the student walk (instance will be restored)')

    // ── Read the grouped world (ADC) to pick a student + deal params ──
    const groups = await inst.collection('groups').get()
    const teamOf = new Map(), pwOf = new Map()
    for (const g of groups.docs) {
      const t = g.data().team_number
      for (const pid of (g.data().trader_participants ?? [])) teamOf.set(pid, t)
      const truth = (await g.ref.collection('truth').doc('team').get()).data()
      if (truth) pwOf.set(t, truth.password)
    }
    // ── Seed a spread of activity so the graph/ownership/leaderboard capture is POPULATED ──
    // Give auctions an ~8-min window (long enough that the mid-flight one is still open at
    // capture, short enough to clear the market cutoff), then seed deals/swap/auctions/block.
    await inst.collection('market').doc('state').update({ auction_duration_minutes: 8 })
    await seedActivity(pids, teamOf, pwOf, instrToken)

    const mePid = pids.find((p) => teamOf.get(p) === 1)
    const meTeam = teamOf.get(mePid)
    const buyerTeam = 2
    const myLic = (await inst.collection('licenses').where('owner_team', '==', meTeam).where('under_auction', '==', null).get()).docs.map((d) => d.data())
    const dealRegion = myLic[0]?.region
    ok(!!mePid && !!dealRegion, `picked student ${mePid} (Team ${meTeam}); will sell 1 in Region ${dealRegion} to Team ${buyerTeam}`)

    // ── Student: real prod session (assignRole → market room) ──
    const stu = await browser.newPage()
    await stu.goto(`${BASE}/?token=${signToken('student', mePid, 'Smoke Trader')}&_session=tab`)
    await stu.locator('[data-testid="market-room"]').waitFor({ timeout: 45_000 })
    await sleep(5000) // let getTeamState resolve so the stat tiles show live (not fallback) values
    ok(true, 'student landed in the five-tab market room on prod')

    // One real deal so the History tab has content (real executeDeal in prod).
    await stu.locator('[data-testid="tab-transactions"]').click()
    await stu.locator(`[data-testid="deal-price-${dealRegion}"]`).fill('250')
    await stu.locator(`[data-testid="deal-buyer-${dealRegion}"]`).fill(String(buyerTeam))
    await stu.locator(`[data-testid="deal-pw-${dealRegion}"]`).fill(String(pwOf.get(buyerTeam) ?? ''))
    await stu.locator(`[data-testid="deal-submit-${dealRegion}"]`).click()
    await sleep(4000) // onActed refresh (getTeamState/History) after the deal

    // Now that every transaction exists (seeded + this browser deal), spread their timestamps
    // across the elapsed window so the graph's X axis is visibly exercised at capture time.
    await spreadTimeline()

    // ── Capture the five student tabs ──
    console.log('\n  Capturing the five student tabs:')
    for (const tab of ['general', 'ownership', 'teams', 'transactions', 'history']) await shoot(stu, tab, `team${meTeam}-${tab}`)
    ok(true, 'five prod student tab screenshots captured')

    // ── Dashboard live progress readout (item 1) — non-zero after the seeded trades ──
    await instr.reload()
    await instr.locator('[data-testid="market-progress"]').waitFor({ timeout: 30_000 }).catch(() => {})
    let progText = ''
    for (let i = 0; i < 20; i++) {
      progText = await instr.locator('[data-testid="market-progress"]').innerText().catch(() => '')
      if (/Current Market Value\s*\$[1-9]/.test(progText)) break
      await sleep(750)
    }
    ok(/Current Market Value\s*\$[1-9]/.test(progText) && /Efficiency captured/.test(progText),
      `dashboard progress readout non-zero (${progText.replace(/\s+/g, ' ').trim()})`)
    await instr.screenshot({ path: path.join(SHOT_DIR, '_dashboard_progress.png'), fullPage: true }).catch(() => {})

    // ── Instructor live-market dashboard (Slice 4) — the SEPARATE /market route, its own
    //    session bootstrap (same instructor JWT). Capture all five projector views. ──
    console.log('\n  Capturing the five INSTRUCTOR views:')
    await instr.goto(`${BASE}/market?token=${instrToken}&game_instance_id=${GID}&_session=tab`)
    await instr.locator('[data-testid="instructor-market"]').waitFor({ timeout: 45_000 })
    await sleep(4000) // let getLeaderboard / licenses onSnapshot resolve before the first shot
    // Sanity: the leaderboard header must show the efficient benchmark (24850 at N=14).
    await instr.locator('[data-testid="nav-performance"]').click()
    for (let i = 0; i < 20; i++) {
      if (await instr.locator('[data-testid="leaderboard-table"]').count()) break
      await sleep(750)
    }
    const perfText = await instr.locator('[data-testid="instructor-market"]').innerText().catch(() => '')
    ok(/24[,.]?850/.test(perfText), `instructor Team Performance shows Efficient Market Value 24,850 (${ms?.efficient_market_value})`)
    for (const view of ['performance', 'ownership', 'graph', 'teams', 'quiz']) {
      await instr.locator(`[data-testid="nav-${view}"]`).click().catch(() => {})
      await sleep(2500)
      if (view === 'graph') {
        const deals = await instr.locator('[data-testid="graph-deal"]').count()
        const aucs  = await instr.locator('[data-testid="graph-auction"]').count()
        const swaps = await instr.locator('[data-testid="graph-swap"]').count()
        ok(deals >= 1 && aucs >= 1 && swaps >= 1, `transaction graph POPULATED (${deals} deals, ${aucs} auctions, ${swaps} swaps)`)
      }
      if (view === 'ownership') {
        const board = await instr.locator('[data-testid="ownership-board"]').innerText().catch(() => '')
        ok(board.includes('🔒'), 'ownership board shows the under-auction 🔒 marker (mid-flight auction)')
      }
      const file = path.join(SHOT_DIR, `instructor-${view}.png`)
      await instr.screenshot({ path: file, fullPage: true })
      log(`  📸 ${view} → ${file}`)
    }
    ok(true, 'five prod instructor view screenshots captured')
  } finally {
    await browser.close().catch(() => {})
    if (!KEEP) await restore(pids)
    else log('KEEP=1 — instance left grouped for inspection')
  }
  console.log(`\n=== ${PASS} passed, ${FAIL} failed · shots in ${SHOT_DIR} ===`)
}

main().then(() => process.exit(FAIL === 0 ? 0 : 1)).catch(async (e) => {
  console.error('\n💥 prod smoke crashed:', e)
  try { if (!KEEP) await restore((await inst.collection('participants').get()).docs.map((d) => d.id)) } catch {}
  process.exit(2)
})
