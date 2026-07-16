/**
 * Spectrum SLICE 3+4+6+7 — PRODUCTION smoke + student-tab, instructor-view & REPORTS screenshots.
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

// An EXPIRED classroom JWT (exp 20 min in the past) — used to PROVE the dry-run item-1 fix: once an
// instructor Firebase session exists, /market and /reports must REUSE it (auth.currentUser) and NOT
// re-exchange the one-time launch token, so an expired token in the URL no longer breaks the page.
function signExpiredToken(role, participantId, name) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({
    iss: 'classroom.mygames.live', sub: participantId, iat: now - 3600, exp: now - 1200,
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
  // Settled auction — team 11 sells with a SHORT window, team 12 bids; we wait for it to END and
  // then settle (settleAuction refuses an auction that hasn't ended; placeBid refuses one that
  // has — so bid now, settle later). Yields a △ graph point once settled.
  const r11 = await freeRegionOf(11)
  let settledAuc = null
  if (r11) {
    await inst.collection('market').doc('state').update({ auction_duration_minutes: 0.5 })
    const a = await callProd('createAuction', { token: tokenOfTeam(11), region: r11, quantity: 1, reserve: 0 })
    await callProd('placeBid', { token: tokenOfTeam(12), auction_id: a.auction_id, amount: 305 })
    settledAuc = { id: a.auction_id, endsAt: a.ends_at, region: r11 }
  }
  // Mid-flight auction — team 13 with a LONG window so it's still OPEN at capture (🔒 marker).
  await inst.collection('market').doc('state').update({ auction_duration_minutes: 8 })
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
  // Now wait for the short auction to end, then settle it (tolerate the Cloud Task/backstop
  // beating us to it — runSettlement is idempotent, so either way we get the settled △ point).
  if (settledAuc) {
    const waitMs = Math.max(0, settledAuc.endsAt - Date.now() + 5000)
    log(`waiting ${Math.round(waitMs / 1000)}s for the short auction to end, then settling…`)
    await sleep(waitMs)
    try { await callProd('settleAuction', { token: instrToken, auction_id: settledAuc.id }) }
    catch (e) { log(`settle note (likely already settled): ${e.message}`) }
    done.push(`auction T11→T12 ${settledAuc.region} $305 settled`)
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

// ── Slice 6: sculpt a DELIBERATELY SCATTERED market for the Report-3 screenshot ─────────
// Report 3 measures how far each region ended from EFFICIENT CONCENTRATION. To make that legible
// we sculpt three distinct region stories via admin owner_team writes (a VISUAL seed, like the
// block above — wiped by restore; getMarketReport reads owner_team as the ownership truth):
//   (1) one region CONSOLIDATED on its schedule-4 team → realized == efficient (1550), gap 0
//   (2) one where a SECOND-HALF team holds a PARTIAL block (5 of 8) → realized well below efficient
//   (3) one SPLIT several ways (2/2/2/1/1 across five weak teams) → large gap
// Then we recompute each team's truth portfolio from the new holdings so the leaderboard (Report 1)
// and ownership board stay CONSISTENT with the sculpted ownership (cash left as the trades left it).
async function sculptScatteredMarket() {
  const { assignedSchedule, valueOfHolding } = await import('./functions/lib/synergy.js')
  const M = N_TEAMS / 2
  const letter = (ri) => String.fromCharCode(64 + ri)
  const ranking = (ri) => {   // teams by value(8) in region ri, strongest first (argmax = schedule-4)
    const arr = []
    for (let g = 1; g <= N_TEAMS; g++) arr.push([g, valueOfHolding(assignedSchedule(g, ri, M), 8)])
    return arr.sort((a, b) => b[1] - a[1] || a[0] - b[0])
  }
  const lic = (await inst.collection('licenses').get()).docs.map((d) => ({
    ref: d.ref, id: d.id, region: d.data().region, ri: d.data().region.charCodeAt(0) - 64,
    auc: d.data().under_auction ?? null,
  }))
  const freeByRi = new Map()
  for (const l of lic) { if (l.auc != null) continue; const a = freeByRi.get(l.ri) ?? []; a.push(l); freeByRi.set(l.ri, a) }
  // Only sculpt regions whose 8 licenses are ALL free (avoid the mid-flight auction's locked license).
  const fullRegions = [...freeByRi.entries()].filter(([, a]) => a.length === 8).map(([ri]) => ri).sort((a, b) => a - b)
  const [consolidatedRi, partialRi, splitRi] = fullRegions

  const batch = db.batch()
  const story = []
  if (consolidatedRi) {   // (1) all 8 → the schedule-4 team (value(8) = 1550) → gap 0
    const team = ranking(consolidatedRi)[0][0]
    for (const l of freeByRi.get(consolidatedRi)) batch.update(l.ref, { owner_team: team })
    story.push(`Region ${letter(consolidatedRi)} consolidated on Team ${team} (all 8 → efficient, gap 0)`)
  }
  if (partialRi) {        // (2) 5 → the schedule-14 runner-up (2nd-half, 1465); the other 3 spread
    const team = ranking(partialRi)[1][0]
    const ls = freeByRi.get(partialRi)
    ls.slice(0, 5).forEach((l) => batch.update(l.ref, { owner_team: team }))
    const others = Array.from({ length: N_TEAMS }, (_, i) => i + 1).filter((g) => g !== team)
    ls.slice(5).forEach((l, i) => batch.update(l.ref, { owner_team: others[i % others.length] }))
    story.push(`Region ${letter(partialRi)} partial block: 2nd-half Team ${team} holds 5 of 8`)
  }
  if (splitRi) {          // (3) 2/2/2/1/1 across five NON-schedule-4 teams → large gap
    const eff = ranking(splitRi)[0][0]
    const holders = Array.from({ length: N_TEAMS }, (_, i) => i + 1).filter((g) => g !== eff).slice(0, 5)
    const shares = [2, 2, 2, 1, 1]
    const ls = freeByRi.get(splitRi)
    let k = 0
    holders.forEach((g, hi) => { for (let c = 0; c < shares[hi] && k < ls.length; c++, k++) batch.update(ls[k].ref, { owner_team: g }) })
    story.push(`Region ${letter(splitRi)} split 2/2/2/1/1 across five teams`)
  }
  await batch.commit()
  log('scattered market sculpted: ' + story.join(' · '))

  // Recompute truth/group holdings + portfolio from the new ownership so Report 1 stays consistent.
  const groups = await inst.collection('groups').get()
  const licAfter = (await inst.collection('licenses').get()).docs.map((d) => ({ id: d.id, region: d.data().region, owner: d.data().owner_team }))
  const tb = db.batch()
  for (const g of groups.docs) {
    const team = g.data().team_number
    if (team == null) continue
    const mine = licAfter.filter((l) => l.owner === team)
    const byRi = new Map()
    for (const l of mine) { const ri = l.region.charCodeAt(0) - 64; byRi.set(ri, (byRi.get(ri) ?? 0) + 1) }
    let licVal = 0
    for (const [ri, c] of byRi) licVal += valueOfHolding(assignedSchedule(team, ri, M), c)
    const truthRef = g.ref.collection('truth').doc('team')
    const cash = Number((await truthRef.get()).data()?.cash ?? 0)
    const ids = mine.map((l) => l.id).sort()
    tb.update(truthRef, { license_ids: ids, portfolio_value: cash + licVal })
    tb.update(g.ref, { license_ids: ids })
  }
  await tb.commit()
}

// Seed finalize fields (admin) so the per-student report (getReportData: finalized_at + raw_score)
// populates for the screenshot — WITHOUT triggering a real gradebook push. Cleaned on restore.
async function seedFinalized(pids) {
  const now = admin.firestore.FieldValue.serverTimestamp()
  const kc = [0.6923076923076923, 1, 0]   // a small illustrative spread on the KC column
  const batch = db.batch()
  pids.forEach((pid, i) => batch.set(inst.collection('participants').doc(pid),
    { finalized_at: now, raw_score: 1, knowledge_check_score: i < kc.length ? kc[i] : null }, { merge: true }))
  await batch.commit()
}

// Fields WE add to a participant (seed + grouping) — deleted on restore to leave the instance bare.
const SEEDED_FIELDS = ['role', 'role_assigned_at', 'attendance_confirmed_at', 'confirmed_ready_at', 'prep_status',
  'group_id', 'is_lead', 'team_number', 'team_password', 'team_synergy', 'team_endowment_regions',
  'team_license_ids', 'team_cash', 'team_license_value', 'team_portfolio_value',
  // KC residue (Slice 5 verification leg) — cleaned so the instance returns fully bare.
  'knowledge_check_completed_at', 'knowledge_check_score', 'knowledge_check_attempts', 'kc_static_answers',
  // Slice 6 Reports: finalize fields seeded so the per-student report (getReportData) populates
  // WITHOUT a real gradebook push — cleaned on restore.
  'finalized_at', 'raw_score']

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

  // ── KC (Slice 5) — the FOUR KC functions must RENDER and SUBMIT in prod (playbook failure
  //    mode #7: render works but submit throws "not a valid graded KC question"). Drive one
  //    seeded trader through the real deployed callables via a classroom-signed JWT. ──
  {
    console.log('\n  Knowledge Check (four functions, render + submit):')
    const kcTok = signToken('student', pids[0], 'KC Smoke')
    const prep = await callProd('getStudentPrepQuestions', { token: kcTok })
    const kcQs = (prep.questions ?? []).filter((q) => /^kc_q\d+$/.test(q.field))
    ok(kcQs.length === 13, `getStudentPrepQuestions renders the 13 graded questions (${kcQs.length})`)
    ok(kcQs.every((q) => q.correct_value === undefined && q.grading === undefined), 'answer keys stripped pre-submit (no correct_value / grading reaches the client)')
    // Gate (submitKnowledgeCheck) — writes knowledge_check_completed_at; required before statics.
    const gate = await callProd('submitKnowledgeCheck', { token: kcTok, answer: 'trader' })
    ok(gate.correct === true, `submitKnowledgeCheck passes the role gate (answer "trader" → correct)`)
    // Statics (submitStaticKnowledgeCheckQuestion) — the failure-mode function; grades by value.
    const q1 = await callProd('submitStaticKnowledgeCheckQuestion', { token: kcTok, field: 'kc_q1', answer: 'q1_sum' })
    ok(q1.correct === true, `submitStaticKnowledgeCheckQuestion grades kc_q1 correct (NOT "not a valid graded KC question")`)
    const q2 = await callProd('submitStaticKnowledgeCheckQuestion', { token: kcTok, field: 'kc_q2', answer: 'q2_610' })
    ok(q2.correct === false, `submitStaticKnowledgeCheckQuestion grades a wrong answer as incorrect (kc_q2 → false)`)
    // getDebriefQuestions — the fourth KC-content function; must resolve for the caller's role.
    const debrief = await callProd('getDebriefQuestions', { token: kcTok })
    ok(Array.isArray(debrief.questions), `getDebriefQuestions resolves (${debrief.questions?.length ?? 0} debrief questions)`)
  }

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
    // (deals + swap + a settled auction + a mid-flight auction + a block; seedActivity manages
    // the short-vs-long auction windows itself). Adds a ~35s wait for the short auction to end.
    await seedActivity(pids, teamOf, pwOf, instrToken)

    const mePid = pids.find((p) => teamOf.get(p) === 1)
    const meTeam = teamOf.get(mePid)
    const buyerTeam = 2
    // Single-field query + JS filter (a compound owner_team==x AND under_auction==null query
    // returns empty in prod — null-equality doesn't compose), matching seedActivity's freeRegionOf.
    const myLic = (await inst.collection('licenses').where('owner_team', '==', meTeam).get()).docs
      .map((d) => d.data()).filter((l) => l.under_auction == null)
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

    // Backend truth: confirm getTransactionGraph returns the seeded points (isolates any cold-start
    // rendering lag in the view from a genuine data problem).
    const graphData = await callProd('getTransactionGraph', { token: instrToken })
    const byType = (graphData.points ?? []).reduce((m, p) => { m[p.type] = (m[p.type] || 0) + 1; return m }, {})
    ok((graphData.points?.length ?? 0) >= 5, `getTransactionGraph returns ${graphData.points?.length ?? 0} points (${JSON.stringify(byType)}, opened_at ${graphData.opened_at ? 'set' : 'null'})`)

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
        // The just-deployed getTransactionGraph can cold-start > one poll — wait for it to paint.
        let deals = 0, aucs = 0, swaps = 0
        for (let i = 0; i < 20; i++) {
          deals = await instr.locator('[data-testid="graph-deal"]').count()
          aucs  = await instr.locator('[data-testid="graph-auction"]').count()
          swaps = await instr.locator('[data-testid="graph-swap"]').count()
          if (deals >= 1 && aucs >= 1 && swaps >= 1) break
          await sleep(750)
        }
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

    // ── Slice 6: REPORTS — sculpt a scattered market, then capture all five reports ─────────
    console.log('\n  Reports page (Slice 6) — sculpt a scattered market, capture all five reports:')
    await sculptScatteredMarket()
    await seedFinalized(pids)

    // Backend truth: getMarketReport reflects the scatter (efficient $1550 everywhere; ≥1 region
    // consolidated at gap 0; ≥1 region with a wide gap) BEFORE we trust the rendered page.
    const rep = await callProd('getMarketReport', { token: instrToken })
    const regs = rep.regions ?? []
    const gap0 = regs.filter((r) => r.gap === 0).length
    const wide = regs.filter((r) => r.gap >= 400).length
    ok(regs.length === N_TEAMS / 2 && regs.every((r) => r.efficient_value === 1550) && gap0 >= 1 && wide >= 1,
      `getMarketReport Report 3: ${regs.length} regions · efficient $1550 · ${gap0} consolidated (gap 0) · ${wide} wide-gap`)
    ok((rep.transactions ?? []).some((t) => t.type === 'deal' && t.acted_by_name),
      'getMarketReport Report 4: the attributed ledger carries deals with team identity + actor name')

    // A projector-height viewport so the modal renders tall enough to prove Report 2's table body
    // scrolls into view (Slice-7 cleanup 2), not just the header, in the fullPage screenshot.
    await instr.setViewportSize({ width: 1280, height: 1500 })
    await instr.goto(`${BASE}/reports?token=${instrToken}&game_instance_id=${GID}&_session=tab`)
    await instr.locator('[data-testid="report-tiles"]').waitFor({ timeout: 45_000 })
    await sleep(5000)   // let getReportData/getLeaderboard/getTransactionGraph/getMarketReport resolve

    // Slice-7 cleanup 1: the Phase-A placeholder prep tile is GONE — the overview shows exactly the
    // five real reports and no "No responses yet" free-text card.
    const tileCount = await instr.locator('[data-testid^="report-tile-"]').count()
    const overviewText = await instr.locator('[data-testid="report-tiles"]').innerText().catch(() => '')
    ok(tileCount === 5 && !/PLACEHOLDER|No responses yet|going-in strategy/i.test(overviewText),
      `Reports overview shows exactly the 5 real reports, no placeholder free-text tile (${tileCount} tiles)`)

    await instr.screenshot({ path: path.join(SHOT_DIR, 'reports-overview.png'), fullPage: true })
    log('  📸 reports overview')

    const openReport = async (tileId, contentTestid, label) => {
      await instr.locator(`[data-testid="report-tile-${tileId}"] button`).click().catch(() => {})
      await instr.locator(`[data-testid="${contentTestid}"]`).waitFor({ timeout: 15_000 }).catch(() => {})
      await sleep(1800)
      await instr.screenshot({ path: path.join(SHOT_DIR, `reports-${label}.png`), fullPage: true })
      log(`  📸 report ${label}`)
      await instr.locator('button:has-text("✕")').first().click().catch(() => {})
      await sleep(700)
    }
    await openReport('leaderboard', 'report-leaderboard', '1-leaderboard')
    // Slice-7 cleanup 2: Report 2's transaction table body must render + be visible (not clipped
    // under the graph). Open it, assert the first ledger ROW is visible, then screenshot.
    await instr.locator('[data-testid="report-tile-history"] button').click().catch(() => {})
    await instr.locator('[data-testid="report-history-table"]').waitFor({ timeout: 15_000 }).catch(() => {})
    await sleep(1500)
    const rowVisible = await instr.locator('[data-testid="report-history-row-0"]').isVisible().catch(() => false)
    ok(rowVisible, 'Report 2 transaction table renders its rows (first ledger row visible in the modal, not just the header)')
    await instr.screenshot({ path: path.join(SHOT_DIR, 'reports-2-history.png'), fullPage: true })
    log('  📸 report 2-history')
    await instr.locator('button:has-text("✕")').first().click().catch(() => {})
    await sleep(700)
    await openReport('regions', 'report-regions', '3-regions')      // ← the focus
    // Report 3 assertion on the RENDERED page: the gap-0 consolidated region row is present.
    await instr.locator('[data-testid="report-tile-regions"] button').click().catch(() => {})
    await instr.locator('[data-testid="report-regions-table"]').waitFor({ timeout: 15_000 }).catch(() => {})
    const regionsText = await instr.locator('[data-testid="report-regions-table"]').innerText().catch(() => '')
    ok(/Region [A-G]/.test(regionsText) && /\$1,?550/.test(regionsText),
      `Report 3 renders per-region rows with the $1,550 efficient benchmark (${regionsText.split('\n').slice(0, 2).join(' / ').trim()})`)
    await instr.locator('button:has-text("✕")').first().click().catch(() => {})
    await sleep(700)
    await openReport('per-team', 'report-per-team', '4-per-team')
    await openReport('per-student', 'report-participation', '5-per-student')
    ok(true, 'five prod REPORTS screenshots captured (Report 3 against the scattered market)')

    // ── Dry-run item 1 PROOF: the instructor session OUTLIVES the one-time launch token ─────────
    // The classroom JWT expires in ~15 min; a market runs 90. Before the fix, opening /market (the
    // "Open live market dashboard" link) or refreshing /reports after expiry re-exchanged the URL
    // token via getInstructorSession → the red "jwt expired" page. The fix reuses auth.currentUser,
    // so an EXPIRED token in the URL is ignored and the page renders from the live Firebase session.
    // We reuse the SAME instr tab (its session is still alive) and re-navigate with an expired token;
    // _session=tab (browserSessionPersistence) is the STRICTER case — real launches use the more
    // durable browserLocalPersistence, so surviving here proves it survives a real 90-min market.
    console.log('\n  Item 1 — instructor session survives an EXPIRED launch token (jwt-expired fix):')
    const expired = signExpiredToken('instructor', 'smoke-instr', 'Smoke Instructor')
    await instr.goto(`${BASE}/market?token=${expired}&game_instance_id=${GID}&_session=tab`)
    const marketSurvives = await instr.locator('[data-testid="instructor-market"]').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false)
    const marketErr = await instr.getByText(/jwt expired/i).count().catch(() => 0)
    ok(marketSurvives && marketErr === 0,
      `/market renders with an EXPIRED token — reused session, no "jwt expired" [survives=${marketSurvives} err=${marketErr}]`)

    await instr.goto(`${BASE}/reports?token=${expired}&game_instance_id=${GID}&_session=tab`)
    const reportsSurvive = await instr.locator('[data-testid="report-tiles"]').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false)
    const reportsErr = await instr.getByText(/jwt expired/i).count().catch(() => 0)
    ok(reportsSurvive && reportsErr === 0,
      `/reports refresh renders with an EXPIRED token — reused session, no "jwt expired" [survives=${reportsSurvive} err=${reportsErr}]`)

    // ── Dry-run item 9 PROOF: the roster "Outcome" column shows team Portfolio Value, not "+1" ────
    // raw_score (the flat +1 participation grade) stays UNCHANGED in the gradebook — only the shown
    // cell + header are repainted from getLeaderboard. Load /dashboard on the finalized instance and
    // assert the roster's rightmost column reads a "$…" portfolio value under a "Portfolio Value" head.
    console.log('\n  Item 9 — roster Outcome column repainted to team Portfolio Value:')
    await instr.goto(`${BASE}/dashboard?token=${instrToken}&game_instance_id=${GID}&_session=tab`)
    await instr.locator('[data-testid="roster-table"]').waitFor({ timeout: 30_000 }).catch(() => {})
    let rosterText = ''
    for (let i = 0; i < 15; i++) {   // let the 1.5s market poll + getLeaderboard + repaint settle
      rosterText = await instr.locator('[data-testid="roster-table"]').innerText().catch(() => '')
      if (/Portfolio Value/.test(rosterText) && /\$[\d,]+/.test(rosterText)) break
      await sleep(1000)
    }
    ok(/Portfolio Value/.test(rosterText), 'roster Outcome header repainted to "Portfolio Value"')
    ok(/\$[\d,]+/.test(rosterText), 'roster rightmost column shows a $ portfolio value (not the flat +1)')
    await instr.screenshot({ path: path.join(SHOT_DIR, 'dashboard-portfolio-column.png'), fullPage: true })
    log('  📸 dashboard portfolio column')
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
