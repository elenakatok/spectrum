/**
 * Spectrum SLICE 3 — THE PRIVACY WALK (Playwright, real browsers).  ← the slice's gate.
 *
 * Drives a full N=14 grouped market, performs a real DEAL (in the browser), a real AUCTION
 * with a winner + a loser, and a real SWAP, then WALKS the DOM and the callable-network of
 * NON-PARTY student sessions and asserts the six leaks are all absent (v3 §7.1 / §2.2 / §3.6):
 *
 *   LEG 1  no price (deal price, auction clearing price, any bid) in a non-party's DOM/API
 *   LEG 2  no team's synergy values in any other team's DOM/API
 *   LEG 3  no team's password in any other team's DOM/API/RTDB — incl. the acting team's OWN
 *          masked field after submit (it must retain nothing)
 *   LEG 4  the auction reserve appears to NOBODY (not bidders, not counterparties, not seller)
 *   LEG 5  the Teams roster is unreachable from an UNAUTHENTICATED session
 *   LEG 6  a losing bidder learns they lost but NOT the clearing price, and not the other bids
 *   LEG 7  the Slice-4 instructor surfaces (transaction graph + leaderboard) are INSTRUCTOR
 *          ONLY BY CONSTRUCTION (v3 §13.1) — a student session is rejected by both reads;
 *          the projector Ownership view reuses the students' component, never a fork
 *
 * Modelled on eBay's "2650" leak-check (games/ebay/ebay-playthrough.mjs): DOM innerText walk
 * of non-party pages + a forbidden-value grep. Extended here with callable-response capture
 * (page.on('response') over the :5005 functions emulator) and an RTDB subtree dump, so LEG 1
 * covers "network payload," LEG 3 covers "RTDB feed," and LEG 5 hits the raw callable.
 *
 * Distinctive economic values (deal price / reserve / bids) are chosen at runtime to NOT
 * collide with any team's synergy cell, so a value hit is a real leak, never a coincidence.
 *
 * RUN (from the spectrum repo root, where playwright resolves):
 *     node spectrum-privacy-walk.mjs
 *   Env: HEADED=1 to watch; KEEP=1 to leave the stack up; SHOTS=1 to also capture tab shots.
 */

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ───────────────────────────────────────────────────────────────────
const PROJECT   = 'spectrum-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FE        = 'http://localhost:5173'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const RTDB      = 'http://localhost:9002'
const DB_NS     = `${PROJECT}-default-rtdb`
const HEADED    = process.env.HEADED === '1'
const KEEP      = process.env.KEEP === '1'
const SHOTS     = process.env.SHOTS === '1'
const PORTS     = [9101, 5005, 8082, 9002, 5006, 4002, 5173]
const GID       = process.env.GID ?? `pw-${Date.now()}`
const N_TEAMS   = 14
const PIDS      = Array.from({ length: N_TEAMS }, (_, i) => `p-${String(i + 1).padStart(2, '0')}`)
const nameOf    = (pid) => `Trader ${pid.slice(2)}`

// ── Tiny harness ───────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const banner = (m) => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const log    = (m) => console.log('  · ' + m)
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✅ ${name}`) }
  else      { FAIL++; console.log(`  ❌ FAILED: ${name}`) }
  return cond
}

// ── Callables (emulator _test/_dev bypass) ──────────────────────────────────────
async function callFn(name, data, { auth = true } = {}) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  const j = await res.json().catch(() => ({}))
  return { ok: res.ok && !j.error, status: res.status, result: j.result, error: j.error, void: auth }
}
const asStudent = (pid, extra) => ({ _test: { participant_id: pid, game_instance_id: GID }, ...extra })
const asDev = (extra) => ({ _dev: { game_instance_id: GID }, ...extra })

// ── Firestore REST (emulator; Bearer owner bypasses rules) ──────────────────────
async function fsGetDoc(suffix) {
  const r = await fetch(`${FIRESTORE}/game_instances/${GID}/${suffix}`, { headers: { Authorization: 'Bearer owner' } })
  return r.ok ? r.json() : null
}
async function fsGetDocs(collection) {
  const r = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })
  return r.ok ? ((await r.json()).documents ?? []) : []
}
async function fsPatch(suffix, field, value) {
  const fields = { [field]: value }
  await fetch(`${FIRESTORE}/game_instances/${GID}/${suffix}?updateMask.fieldPaths=${field}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
}
const strVal = (f) => f?.stringValue ?? ''
const numVal = (f) => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue ?? null))
// synergy = arrayValue[ mapValue{ region, values: arrayValue[int...] } ]
function synergyCellsOf(participantDoc) {
  const rows = participantDoc?.fields?.team_synergy?.arrayValue?.values ?? []
  const out = []
  for (const r of rows) {
    for (const v of (r.mapValue?.fields?.values?.arrayValue?.values ?? [])) {
      const n = numVal(v)
      if (n != null) out.push(n)
    }
  }
  return out
}

// ── Local stack (unconditional clean-start; mirrors spectrum-playthrough.mjs) ────
const children = []
function freePorts() {
  for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* none */ } }
}
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(url); if (r.status > 0) return } catch { /* down */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} (${url}) never came up`)
    await sleep(700)
  }
}
function spawnLogged(cmd, args, cwd, logFile) {
  const out = openSync(logFile, 'a')
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', out, out] })
  children.push(child); return child
}
async function bringUpStack() {
  banner('CLEAN-START — tear down + rebuild the local stack')
  freePorts(); await sleep(1200)
  writeFileSync(path.join(ROOT, 'functions/.env.local'),
    'CLASSROOM_CALLBACK_URL=http://127.0.0.1:1/none\nCLASSROOM_ROSTER_URL=http://127.0.0.1:1/none\n')
  writeFileSync(path.join(ROOT, 'frontend/.env.local'), [
    'VITE_FIREBASE_API_KEY=dev-placeholder',
    `VITE_FIREBASE_PROJECT_ID=${PROJECT}`,
    `VITE_FIREBASE_AUTH_DOMAIN=${PROJECT}.firebaseapp.com`,
    `VITE_FIREBASE_STORAGE_BUCKET=${PROJECT}.firebasestorage.app`,
    'VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000',
    'VITE_FIREBASE_APP_ID=1:000000000000:web:000000000000000000000000',
    `VITE_FIREBASE_DATABASE_URL=https://${PROJECT}-default-rtdb.firebaseio.com`, '',
  ].join('\n'))
  console.log('▶ Building Cloud Functions…')
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  console.log('▶ Starting emulators + Vite…')
  spawnLogged('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], ROOT, path.join(ROOT, 'privacy-emu.log'))
  spawnLogged('npm', ['run', 'dev'], path.join(ROOT, 'frontend'), path.join(ROOT, 'privacy-vite.log'))
  await waitHttp('http://localhost:9101/', 'auth emulator')
  await waitHttp('http://localhost:8082/', 'firestore emulator')
  await waitHttp(`${RTDB}/.json`, 'database emulator')
  await waitHttp(`${FUNCTIONS}/health`, 'functions emulator')
  await waitHttp(`${FE}/`, 'Vite dev server')
  await sleep(6000); console.log('  Stack ready ✅')
}
function tearDown() {
  if (KEEP) { console.log('\n(KEEP=1 — leaving the stack up)'); return }
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ } }
  freePorts()
}

// ── Seed 14 present traders, then group + open the market ───────────────────────
async function seedAndGroup() {
  banner('SEED 14 present traders → group → open market')
  const r = await fetch(`${FUNCTIONS}/seedMatchTest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: GID, clear: true, participants: PIDS.map((id) => ({ id, role: 'trader', present: true })) }),
  })
  assert(r.ok, 'seedMatchTest seeded 14 present traders')
  for (const pid of PIDS) await fsPatch(`participants/${pid}`, 'display_name', { stringValue: nameOf(pid) })

  const g = await callFn('groupParticipants', asDev({ num_teams: N_TEAMS }))
  assert(g.ok && g.result?.teams_created === N_TEAMS, `groupParticipants formed ${N_TEAMS} teams (efficient value ${g.result?.efficient_market_value})`)
  // ITEM 2 — group_id now sorts in TEAM ORDER (team-01 … team-NN), so the shared roster's
  // "Team #" column (numbered by group_id sort order) equals the real team_number instead of a
  // meaningless UUID permutation. Assert the invariant that makes that column correct.
  {
    const gd = (await fsGetDocs('groups'))
      .map((d) => ({ id: d.name.split('/').pop(), team: numVal(d.fields?.team_number) }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const matches = gd.length === N_TEAMS && gd.every((x, i) => x.team === i + 1)
    assert(matches, `ITEM 2 — group_id sort order == team_number (roster "Team #" correct): teams [${gd.map((x) => x.team).join(',')}]`)
  }
  const s = await callFn('startMarket', asDev({}))
  assert(s.ok, 'startMarket opened the market')
  // 60s auction window: long enough that the pre-settle DOM walk (~25s) runs entirely while the
  // auction is OPEN (so we prove even the SELLER can't see a sealed bid), short enough to settle
  // within the harness. Market cutoff is 85 min away, so this is well within the cutoff rule.
  await fsPatch('market/state', 'auction_duration_minutes', { doubleValue: 1 })
}

// ── Read the team ⇄ pid ⇄ password ⇄ holdings map (Bearer owner) ────────────────
async function readWorld() {
  const groups = await fsGetDocs('groups')
  const truthByTeam = new Map()
  for (const gdoc of groups) {
    const gid = gdoc.name.split('/').pop()
    const t = await fsGetDoc(`groups/${gid}/truth/team`)
    const team = numVal(t?.fields?.team_number)
    if (team != null) truthByTeam.set(team, { password: strVal(t.fields.password), members: (gdoc.fields?.trader_participants?.arrayValue?.values ?? []).map((v) => v.stringValue) })
  }
  const licenses = (await fsGetDocs('licenses')).map((d) => ({ id: d.name.split('/').pop(), region: strVal(d.fields?.region), owner_team: numVal(d.fields?.owner_team) }))
  const regionsByTeam = new Map()
  for (const l of licenses) { const s = regionsByTeam.get(l.owner_team) ?? new Set(); s.add(l.region); regionsByTeam.set(l.owner_team, s) }
  const synergyUnion = new Set()
  for (const pid of PIDS) for (const v of synergyCellsOf(await fsGetDoc(`participants/${pid}`))) synergyUnion.add(v)
  return { truthByTeam, regionsByTeam, synergyUnion, passwords: [...truthByTeam.values()].map((v) => v.password) }
}
const pidForTeam = (world, team) => world.truthByTeam.get(team).members[0]
const passwordForTeam = (world, team) => world.truthByTeam.get(team).password
const aRegionOf = (world, team) => [...world.regionsByTeam.get(team)].sort()[0]

// ── Browser session with callable-network capture ───────────────────────────────
let browser = null
async function openStudent(pid) {
  const page = await browser.newPage()
  const api = []   // callable (:5005) JSON responses this page RECEIVED
  const net = []   // all text-ish responses (incl. Firestore listen frames)
  page.on('response', async (resp) => {
    const url = resp.url()
    if (!/:5005|:8082/.test(url)) return
    const body = await resp.text().catch(() => '')
    if (!body) return
    net.push(body)
    if (url.includes(':5005')) api.push(body)
  })
  await page.goto(`${FE}/?_pid=${pid}&_gid=${GID}&_session=tab`)
  await page.waitForSelector('[data-testid="market-room"]', { timeout: 30_000 })
  return { pid, page, api, net, dom: '' }
}
async function renderAllTabs(stu) {
  let dom = ''
  for (const tab of ['general', 'ownership', 'teams', 'transactions', 'history']) {
    await stu.page.locator(`[data-testid="tab-${tab}"]`).click().catch(() => {})
    await sleep(700)
    dom += '\n' + (await stu.page.locator('body').innerText().catch(() => ''))
    if (SHOTS) { mkdirSync(path.join(ROOT, 'privacy-shots', GID), { recursive: true }); await stu.page.screenshot({ path: path.join(ROOT, 'privacy-shots', GID, `${stu.pid}-${tab}.png`), fullPage: true }).catch(() => {}) }
  }
  stu.dom = dom
}
const hay = (stu) => stu.dom + '\n' + stu.net.join('\n')          // DOM + ALL network (for STRING greps: passwords)
const apiText = (stu) => stu.api.join('\n')                        // just the :5005 callable responses
// For NUMERIC value greps (prices/bids/reserve) the surface is DOM + callable responses ONLY.
// Prices provably never transit the public :8082 docs (truth/transactions/auctions/bids are
// rules-denied), and raw Firestore listen frames are full of nanosecond timestamps + UUIDs that
// a bare number-substring match false-hits. So a price can only reach a client via a callable or
// the rendered DOM — those are exactly hayV.
// scrub(): drop thousands-commas ($1,691 → $1691) and neutralise the volatile PUBLIC
// time_remaining_ms countdown (0–3000 ms, non-secret) so neither substring-collides with a
// price. Then hasVal matches the value only as a STANDALONE number (digit boundaries) — a
// leaked price appears as its OWN field/value, never buried inside a larger number.
const scrub = (t) => t.replace(/"time_remaining_ms":\s*\d+/g, '"time_remaining_ms":0').replace(/,/g, '')
const hayV = (stu) => scrub(stu.dom + '\n' + apiText(stu))
const hasVal = (text, v) => new RegExp(`(?<![0-9])${v}(?![0-9])`).test(text)
// Debug: show ±40 chars around every standalone-match of v in text (to distinguish real leaks).
const matchCtx = (text, v) => {
  const out = []
  const re = new RegExp(`(?<![0-9])${v}(?![0-9])`, 'g')
  let m
  while ((m = re.exec(text)) && out.length < 4) out.push('…' + text.slice(Math.max(0, m.index - 40), m.index + String(v).length + 20).replace(/\s+/g, ' ') + '…')
  return out.join(' | ')
}

// ── MAIN ────────────────────────────────────────────────────────────────────────
async function main() {
  await bringUpStack()
  await seedAndGroup()
  const world = await readWorld()

  // Cast the players by team number (deterministic p-0k ↔ team k, but read to be safe).
  const DEAL_SELLER = 1, DEAL_BUYER = 2, AUC_SELLER = 3, WINNER = 4, LOSER = 5, BYS1 = 6, BYS2 = 7
  const parties = { DEAL_SELLER, DEAL_BUYER, AUC_SELLER, WINNER, LOSER, BYS1, BYS2 }

  // Distinctive economic values that do NOT collide with any synergy cell (≤ 1000 for bids/price).
  const pick = (cands) => cands.find((v) => !world.synergyUnion.has(v))
  const DEAL_PRICE = pick([787, 781, 773, 769, 761])
  const WIN_BID    = pick([691, 683, 677, 673, 661])
  const LOSE_BID   = pick([547, 541, 523, 521, 509])
  const RESERVE    = pick([461, 457, 449, 443, 439])  // ≤ both bids so the sale actually clears
  log(`values — deal $${DEAL_PRICE}, winning bid $${WIN_BID}, losing bid $${LOSE_BID}, reserve $${RESERVE} (all non-synergy)`)

  browser = await chromium.launch({ headless: !HEADED })
  const studs = {}
  for (const team of Object.values(parties)) studs[team] = await openStudent(pidForTeam(world, team))

  // ── ACTION 1: a real DEAL in the SELLER's browser (the leg-3 password path) ─────
  banner('ACTIONS — deal (browser) · auction+bids (callable) · swap (callable)')
  const dealRegion = aRegionOf(world, DEAL_SELLER)
  const buyerPw = passwordForTeam(world, DEAL_BUYER)
  const seller = studs[DEAL_SELLER]
  // Give the seller a SECOND license in the deal region (from a team with no browser, 8–14)
  // so selling ONE doesn't empty the row — that lets us assert the masked field CLEARS in
  // place (not merely disappears) after submit. Truth/licenses desync on the donor team is
  // irrelevant here (it has no session and is not walked).
  const donor = (await fsGetDocs('licenses')).map((d) => ({ id: d.name.split('/').pop(), region: strVal(d.fields?.region), owner: numVal(d.fields?.owner_team) }))
    .find((l) => l.region === dealRegion && l.owner >= 8)
  if (donor) { await fsPatch(`licenses/${donor.id}`, 'owner_team', { integerValue: String(DEAL_SELLER) }); await sleep(1500) }
  await seller.page.locator('[data-testid="tab-transactions"]').click()
  await seller.page.locator(`[data-testid="deal-price-${dealRegion}"]`).fill(String(DEAL_PRICE))
  await seller.page.locator(`[data-testid="deal-buyer-${dealRegion}"]`).fill(String(DEAL_BUYER))
  await seller.page.locator(`[data-testid="deal-pw-${dealRegion}"]`).fill(buyerPw)
  await seller.page.locator(`[data-testid="deal-submit-${dealRegion}"]`).click()
  await sleep(1800)
  // Field CLEARS in place if the row survived (donor gave a 2nd license); otherwise it's gone
  // entirely — both mean "retains nothing". Capture which happened.
  const pwLoc = seller.page.locator(`[data-testid="deal-pw-${dealRegion}"]`)
  const pwStillPresent = (await pwLoc.count()) > 0
  const pwFieldAfter = pwStillPresent ? await pwLoc.inputValue().catch(() => '?') : '(row removed)'
  const sellerDomAfter = await seller.page.locator('body').innerText()

  // ── ACTION 2: auction (callables) — winner + loser, then settle ─────────────────
  const aucRegion = aRegionOf(world, AUC_SELLER)
  const created = await callFn('createAuction', asStudent(pidForTeam(world, AUC_SELLER), { region: aucRegion, quantity: 1, reserve: RESERVE }))
  const auctionId = created.result?.auction_id
  const auctionEndsAt = created.result?.ends_at ?? (Date.now() + 60_000)
  assert(created.ok && auctionId, `auction created in Region ${aucRegion} with a private reserve`)
  const wBid = await callFn('placeBid', asStudent(pidForTeam(world, WINNER), { auction_id: auctionId, amount: WIN_BID }))
  const lBid = await callFn('placeBid', asStudent(pidForTeam(world, LOSER), { auction_id: auctionId, amount: LOSE_BID }))
  assert(wBid.ok && lBid.ok, 'winner and loser each placed one sealed bid')

  // ── ACTION 3: a swap (callable, no price) between two other teams ────────────────
  const swR = aRegionOf(world, BYS1)
  const swR2 = [...world.regionsByTeam.get(BYS2)].sort().find((r) => r !== swR) ?? aRegionOf(world, BYS2)
  await callFn('executeSwap', asStudent(pidForTeam(world, BYS1), { regionX: swR, quantityX: 1, regionY: swR2, quantityY: 1, partnerTeam: BYS2, partnerPassword: passwordForTeam(world, BYS2) }))

  // Engineer a visible 2-license BLOCK for a NON-party team (10) so the ownership board's block
  // styling (item 3b) is exercised — every prior screenshot showed only the empty opening board.
  // Actions are already done, so reassigning ownership here only affects what the board RENDERS.
  // Pick a region that's neither under auction nor a transaction region, so the block cell is
  // cleanly blue (not also locked) and no walked team's just-completed trade is disturbed.
  const BLOCK_TEAM = 10
  const allLic = (await fsGetDocs('licenses')).map((d) => ({
    id: d.name.split('/').pop(), region: strVal(d.fields?.region),
    auc: d.fields?.under_auction?.stringValue ?? null,
  }))
  const excluded = new Set([aucRegion, dealRegion, swR, swR2])
  const blockRegion = [...new Set(allLic.map((l) => l.region))].sort()
    .find((r) => !excluded.has(r) && allLic.filter((l) => l.region === r && !l.auc).length >= 2)
  const blockLic = allLic.filter((l) => l.region === blockRegion && !l.auc).slice(0, 2)
  for (const l of blockLic) await fsPatch(`licenses/${l.id}`, 'owner_team', { integerValue: String(BLOCK_TEAM) })
  const aucLic = allLic.find((l) => l.auc)   // the license the live auction has locked
  await sleep(1500)

  // Let every open page fetch fresh state (the auction is OPEN — bystanders call getAuctionState).
  for (const s of Object.values(studs)) await renderAllTabs(s)

  // ── ITEM 3b — the ownership board renders the BLOCK (blue) + UNDER-AUCTION (🔒) states. ──
  {
    const viewer = studs[BYS1]   // team 6 — neither the block team nor the auction seller
    await viewer.page.locator('[data-testid="tab-ownership"]').click()
    await sleep(1200)
    const bgOf   = (id) => viewer.page.locator(`[data-testid="own-${id}"]`).evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '')
    const textOf = (id) => viewer.page.locator(`[data-testid="own-${id}"]`).innerText().catch(() => '')
    const blocksBlue = (await Promise.all(blockLic.map((l) => bgOf(l.id)))).every((bg) => bg === 'rgb(238, 244, 255)')
    assert(blockLic.length === 2 && blocksBlue, `ITEM 3b — a 2-license block (team ${BLOCK_TEAM}, Region ${blockRegion}) renders BLUE on the ownership board`)
    const aucText = aucLic ? (await textOf(aucLic.id)).trim() : ''
    const aucBg   = aucLic ? await bgOf(aucLic.id) : ''
    assert(!!aucLic && aucText.includes('🔒') && aucBg === 'rgb(253, 226, 221)',
      `ITEM 3b — the under-auction license renders the 🔒 lock marker + red tint (got "${aucText}", ${aucBg})`)
  }

  // ── LEG 4 & LEG 1 (open-auction phase): reserve to nobody; bids/price to non-parties ──
  banner('THE PRIVACY WALK')
  const nonParties = (allow) => Object.entries(parties).filter(([, t]) => !allow.includes(t)).map(([, t]) => t)

  // LEG 4 — reserve appears to NOBODY (every open browser, incl. the auction seller).
  {
    const leaks = Object.values(studs).filter((s) => hasVal(hayV(s), RESERVE)).map((s) => s.pid)
    assert(leaks.length === 0, `LEG 4 — auction reserve ($${RESERVE}) appears to NOBODY (DOM+API of all ${Object.keys(studs).length} sessions; leaked: [${leaks.join(', ')}])`)
  }

  // LEG 1a — deal price only to the two parties (seller, buyer).
  {
    const forbid = nonParties([DEAL_SELLER, DEAL_BUYER])
    const leaks = forbid.filter((t) => hasVal(hayV(studs[t]), DEAL_PRICE))
    assert(leaks.length === 0, `LEG 1 — deal price ($${DEAL_PRICE}) never reaches a non-party (checked teams [${forbid.join(', ')}]; leaked: [${leaks.join(', ')}])`)
  }
  // LEG 1b — bids never reach a non-bidder (winning bid / losing bid).
  {
    const wForbid = nonParties([WINNER])   // pre-settle, only the winner knows its own bid
    const lForbid = nonParties([LOSER])
    const wl = wForbid.filter((t) => hasVal(hayV(studs[t]), WIN_BID))
    const ll = lForbid.filter((t) => hasVal(hayV(studs[t]), LOSE_BID))
    for (const t of wl) log(`   DEBUG win-bid ctx team ${t}: ${matchCtx(hayV(studs[t]), WIN_BID)}`)
    assert(wl.length === 0 && ll.length === 0, `LEG 1 — sealed bids stay private (winning $${WIN_BID} leaked to [${wl.join(', ')}]; losing $${LOSE_BID} leaked to [${ll.join(', ')}])`)
  }

  // LEG 2 — no team's synergy transits any callable, and no cross-team synergy in any DOM.
  {
    const apiSynergy = Object.values(studs).filter((s) => /synergy/i.test(apiText(s))).map((s) => s.pid)
    assert(apiSynergy.length === 0, `LEG 2 — no synergy field in ANY read-callable response (getTeamState/History/Directory/AuctionState); offenders: [${apiSynergy.join(', ')}]`)
    // DOM: each page shows exactly ONE synergy table — its own. A cross-team leak would add
    // another team's distinctive high cell. Spot-check: bystander BYS2's page must not contain
    // the auction seller's strongest region cell that BYS2's own schedule doesn't have.
    const foreign = distinctSynergyCell(await fsGetDoc(`participants/${pidForTeam(world, AUC_SELLER)}`), await fsGetDoc(`participants/${pidForTeam(world, BYS2)}`))
    const leaked = foreign != null && hasVal(hayV(studs[BYS2]), foreign)
    assert(foreign == null || !leaked, `LEG 2 — another team's private synergy value (${foreign}) does not appear on a bystander's page`)
  }

  // LEG 3 — passwords: none but the OWN team's, anywhere; the acting field retains nothing.
  {
    let crossLeak = []
    for (const [, team] of Object.entries(parties)) {
      const mine = passwordForTeam(world, team)
      const others = world.passwords.filter((p) => p !== mine)
      const seen = others.filter((p) => hay(studs[team]).includes(p))
      if (seen.length) crossLeak.push(`team ${team} saw [${seen.join(', ')}]`)
    }
    assert(crossLeak.length === 0, `LEG 3 — no team sees another team's password in DOM/API (${crossLeak.join('; ') || 'clean'})`)
    assert(pwFieldAfter === '' || !pwStillPresent, `LEG 3 — the masked password field retains NOTHING after submit (${pwStillPresent ? `value="${pwFieldAfter}"` : 'row removed — lot sold out'})`)
    assert(!sellerDomAfter.includes(buyerPw), `LEG 3 — the buyer's password ("${buyerPw}") is not retained anywhere on the seller's screen after submit`)
  }

  // ── wait for the auction to END, then settle → LEG 6 + a post-settle re-walk ─────
  await sleep(Math.max(0, auctionEndsAt - Date.now() + 2000))
  const settled = await callFn('settleAuction', asDev({ auction_id: auctionId }))
  assert(settled.ok && settled.result?.winner_team === WINNER && settled.result?.clearing_price === WIN_BID,
    `auction settled: team ${WINNER} won at $${WIN_BID}`)

  // LEG 6 — the loser learns it lost but NOT the clearing price, nor other bids.
  {
    const asLoser = await callFn('getAuctionState', asStudent(pidForTeam(world, LOSER), { auction_id: auctionId }))
    const asWinner = await callFn('getAuctionState', asStudent(pidForTeam(world, WINNER), { auction_id: auctionId }))
    const asBystander = await callFn('getAuctionState', asStudent(pidForTeam(world, BYS1), { auction_id: auctionId }))
    const loserBlob = JSON.stringify(asLoser.result ?? {})
    const okLoser = asLoser.result?.you_won === false && asLoser.result?.clearing_price == null && !loserBlob.includes(String(WIN_BID))
    const okWinner = asWinner.result?.clearing_price === WIN_BID   // a party DOES learn the price
    // A non-bidding bystander gets you_won:false too (information-free — they know they didn't
    // bid); the privacy invariant is that the CLEARING PRICE and other bids never reach them.
    const bysBlob = JSON.stringify(asBystander.result ?? {})
    const okBys = asBystander.result?.clearing_price == null && !bysBlob.includes(String(WIN_BID)) && !bysBlob.includes(String(LOSE_BID))
    assert(okLoser, `LEG 6 — loser learns you_won=false with NO clearing price and no other bid (got ${loserBlob})`)
    assert(okWinner, `LEG 6 — (sanity) the winning party DOES learn the clearing price ($${asWinner.result?.clearing_price})`)
    assert(okBys, `LEG 6 — a non-party bystander learns no price and no bid (got ${bysBlob})`)
  }

  // LEG 5 — the roster is unreachable UNAUTHENTICATED (no _test, no Bearer, no token).
  {
    const unauth = await callFn('getTeamsDirectory', {})   // nothing that identifies a session
    const denied = !unauth.ok && /unauth|invalid|token|argument/i.test(JSON.stringify(unauth.error ?? {}) + unauth.status)
    assert(denied, `LEG 5 — getTeamsDirectory is REJECTED without auth (status ${unauth.status}, ${JSON.stringify(unauth.error ?? {})})`)
    const authed = await callFn('getTeamsDirectory', asStudent(pidForTeam(world, BYS1), {}))
    assert(authed.ok && Array.isArray(authed.result?.teams), 'LEG 5 — (sanity) an AUTHENTICATED student CAN read the roster')
  }

  // LEG 3 (RTDB) — no password anywhere in the world-readable RTDB subtree.
  {
    const dump = await (await fetch(`${RTDB}/.json?ns=${DB_NS}`, { headers: { Authorization: 'Bearer owner' } })).text()
    const inRtdb = world.passwords.filter((p) => dump.includes(p))
    assert(inRtdb.length === 0, `LEG 3 — no team password transits the RTDB feed (leaked: [${inRtdb.join(', ')}])`)
  }

  // Post-settle re-walk: the clearing price must STILL not reach the loser or any non-party.
  for (const s of Object.values(studs)) { s.net.length = 0; s.api.length = 0; await renderAllTabs(s) }
  {
    const forbid = nonParties([AUC_SELLER, WINNER])   // only the two sale parties may see the clearing price
    const leaks = forbid.filter((t) => hasVal(hayV(studs[t]), WIN_BID))
    assert(leaks.length === 0, `LEG 1/6 — post-settlement, clearing price ($${WIN_BID}) still reaches no non-party (checked [${forbid.join(', ')}]; leaked: [${leaks.join(', ')}])`)
  }

  // ── LEG 7 — the Slice-4 instructor surfaces: leaderboard + transaction graph ─────
  // The transaction graph is instructor-only BY CONSTRUCTION (v3 §13.1): there is no student
  // path to it. Assert (a) a STUDENT session is REJECTED by both new reads; (b) the INSTRUCTOR
  // sees the cross-team leaderboard (14 teams + the efficient benchmark) and the price graph
  // (the deal, the settled auction, the price-less swap); (c) the projector Ownership view
  // REUSES the students' component (imported, not re-implemented).
  {
    const gStu = await callFn('getTransactionGraph', asStudent(pidForTeam(world, BYS1), {}))
    const lStu = await callFn('getLeaderboard', asStudent(pidForTeam(world, BYS1), {}))
    const rejected = (r) => !r.ok && /unauth|permission|invalid|token|instructor|argument/i.test(JSON.stringify(r.error ?? {}) + r.status)
    assert(rejected(gStu) && rejected(lStu),
      `LEG 7 — a STUDENT is rejected by getTransactionGraph (status ${gStu.status}) and getLeaderboard (status ${lStu.status}) — instructor only`)

    const board = await callFn('getLeaderboard', asDev({}))
    const state = await callFn('getMarketState', asDev({}))
    const eff = state.result?.efficient_market_value
    const okBoard = board.ok && board.result?.teams?.length === N_TEAMS &&
      board.result.efficient_market_value === eff && eff > 0 &&
      typeof board.result.total_initial_value === 'number' &&
      typeof board.result.value_after_trade === 'number'
    assert(okBoard, `LEG 7 — instructor leaderboard: ${board.result?.teams?.length} teams · Efficient Market Value $${eff} · value-after-trade $${board.result?.value_after_trade}`)

    const graph = await callFn('getTransactionGraph', asDev({}))
    const pts = graph.result?.points ?? []
    const hasDeal = pts.some((p) => p.type === 'deal' && p.price_per_license === DEAL_PRICE)
    const hasAuc  = pts.some((p) => p.type === 'auction' && p.price_per_license === WIN_BID)
    const hasSwap = pts.some((p) => p.type === 'swap' && p.price_per_license == null)
    assert(graph.ok && hasDeal && hasAuc && hasSwap && graph.result?.opened_at != null,
      `LEG 7 — instructor graph carries cross-team prices: deal $${DEAL_PRICE}/lic, auction $${WIN_BID}/lic, swap price-less (${pts.length} points)`)

    // Static guard: the projector Ownership view REUSES the student component, never a fork —
    // its board testid lives ONLY in the shared component, so the projector must merely import it.
    const src = readFileSync(path.join(ROOT, 'frontend/src/pages/InstructorMarket.tsx'), 'utf8')
    const importsBoard = /import OwnershipBoard from ['"]\.\.\/market\/OwnershipBoard['"]/.test(src)
    const noFork = !/data-testid="ownership-board"/.test(src)
    assert(importsBoard && noFork, 'LEG 7 — the projector imports the shared OwnershipBoard (not a duplicate)')
  }

  banner(`RESULT — ${PASS} passed, ${FAIL} failed`)
  if (SHOTS) console.log(`  tab screenshots → ${path.join(ROOT, 'privacy-shots', GID)}`)
}

// A synergy cell value that team A has and team B does NOT (for the leg-2 spot check).
function distinctSynergyCell(aDoc, bDoc) {
  const a = new Set(synergyCellsOf(aDoc)), b = new Set(synergyCellsOf(bDoc))
  for (const v of a) if (!b.has(v) && v > 500) return v   // >500 → distinctive, unlikely to collide with a price
  return null
}

main()
  .catch((e) => { console.error('\n💥 privacy walk crashed:', e); FAIL++ })
  .finally(async () => {
    try { if (browser) await browser.close() } catch { /* ignore */ }
    tearDown()
    process.exit(FAIL === 0 ? 0 : 1)
  })
