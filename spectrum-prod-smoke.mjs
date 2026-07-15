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
    const mePid = pids.find((p) => teamOf.get(p) === 1)
    const meTeam = teamOf.get(mePid)
    const buyerTeam = 2
    const myLic = (await inst.collection('licenses').where('owner_team', '==', meTeam).get()).docs.map((d) => d.data())
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

    // ── Capture the five student tabs ──
    console.log('\n  Capturing the five student tabs:')
    for (const tab of ['general', 'ownership', 'teams', 'transactions', 'history']) await shoot(stu, tab, `team${meTeam}-${tab}`)
    ok(true, 'five prod student tab screenshots captured')

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
