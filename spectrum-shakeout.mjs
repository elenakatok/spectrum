/**
 * Spectrum SLICE 7 — the LIVE-SCALE SHAKEOUT (backend, emulator). The closest thing to a real
 * classroom before humans: a FULL N=14 endowed market driven under realistic CONCURRENT load.
 *
 * Boots the emulator, groups a real 14-team market (real endowments/synergy/passwords), then
 * drives waves of overlapping activity — concurrent deals, swaps, simultaneous auctions with real
 * bidding — with deliberate CONTENTION (two teams buying the same license at once; a team bidding
 * while selling; an escrow squeeze), auctions closing (Cloud Task + backstop) WHILE trades are in
 * flight, and a HARD CLOSE firing with actions queued. The seven invariants are asserted
 * CONTINUOUSLY (a sweep after every wave) — especially cash conservation (7) and one-owner (1).
 *
 * Then the NAMED ASSERTION (v3 §15): ledger reconciliation — replay the whole transaction log from
 * the endowments and reproduce the live final state EXACTLY (delegated to spectrum-reconcile.mjs,
 * the reusable module that also runs against prod after the human dry run).
 *
 *   node spectrum-shakeout.mjs        (env: KEEP=1 to leave the stack up on exit)
 */
import { openSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { valueOfHolding, assignedSchedule } from './functions/lib/synergy.js'
import { reconcile } from './spectrum-reconcile.mjs'

const PROJECT   = 'spectrum-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const PORTS     = [9101, 5005, 8082, 9002]
const GID       = process.env.GID ?? `shk-${Date.now()}`
const N_TEAMS   = 14
const M_REGIONS = N_TEAMS / 2
const STARTING_CASH = 1000                       // grouping default (DEFAULT_STARTING_CASH)
const LICENSE_TOTAL = M_REGIONS * 8              // 4N = 56 licenses at N=14
const PIDS      = Array.from({ length: N_TEAMS }, (_, i) => `p-${String(i + 1).padStart(2, '0')}`)
const nameOf    = (pid) => `Trader ${pid.slice(2)}`

// ── tiny harness ────────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const banner = (m) => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const log = (m) => console.log('  · ' + m)
function assert(cond, name) { if (cond) { PASS++; console.log(`  ✓ ${name}`) } else { FAIL++; console.log(`  ✗ FAILED: ${name}`) }; return cond }

// ── callables (emulator _test/_dev bypass) ────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}
const asStudent = (pid, extra) => ({ _test: { participant_id: pid, game_instance_id: GID }, ...extra })
const asDev = (extra) => ({ _dev: { game_instance_id: GID }, ...extra })
const deal = (pid, region, quantity, price, buyerTeam, buyerPassword) => callFn('executeDeal', asStudent(pid, { region, quantity, price, buyerTeam, buyerPassword }))
const swap = (pid, regionX, quantityX, regionY, quantityY, partnerTeam, partnerPassword) => callFn('executeSwap', asStudent(pid, { regionX, quantityX, regionY, quantityY, partnerTeam, partnerPassword }))
const createAuction = (pid, region, quantity, reserve) => callFn('createAuction', asStudent(pid, { region, quantity, reserve }))
const placeBid = (pid, auctionId, amount) => callFn('placeBid', asStudent(pid, { auction_id: auctionId, amount }))
const settle = (auctionId) => callFn('settleAuction', asDev({ auction_id: auctionId }))
const getAuctionState = (pid, auctionId) => callFn('getAuctionState', asStudent(pid, { auction_id: auctionId }))
const getMarketState = () => callFn('getMarketState', asDev({}))
async function fireCloudTask(auctionId) {
  const res = await fetch(`${FUNCTIONS}/settleAuctionTask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { game_instance_id: GID, auction_id: auctionId } }) })
  return { status: res.status }
}

// ── Firestore REST (Bearer owner) ─────────────────────────────────────────────────
async function fsGet(suffix) { const r = await fetch(`${FIRESTORE}/game_instances/${GID}/${suffix}`, { headers: { Authorization: 'Bearer owner' } }); return r.ok ? r.json() : null }
async function fsList(collection) { const r = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } }); return r.ok ? ((await r.json()).documents ?? []) : [] }
async function fsSub(collectionPath) { const r = await fetch(`${FIRESTORE}/game_instances/${GID}/${collectionPath}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } }); return r.ok ? ((await r.json()).documents ?? []) : [] }
async function fsPatch(suffix, field, value) {
  await fetch(`${FIRESTORE}/game_instances/${GID}/${suffix}?updateMask.fieldPaths=${field}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [field]: value } }),
  })
}
const numVal = (f) => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue != null ? f.doubleValue : null))
const strVal = (f) => f?.stringValue ?? null
const arrVal = (f) => (f?.arrayValue?.values ?? []).map((v) => v.stringValue)

// ── the world (team ⇄ pid ⇄ password ⇄ holdings), read once after grouping ─────────
async function readWorld() {
  const groups = await fsList('groups')
  const truthByTeam = new Map()
  for (const g of groups) {
    const gid = g.name.split('/').pop()
    const t = await fsGet(`groups/${gid}/truth/team`)
    const team = numVal(t?.fields?.team_number)
    if (team != null) truthByTeam.set(team, { gid, password: strVal(t.fields.password), pid: (g.fields?.trader_participants?.arrayValue?.values ?? [])[0]?.stringValue })
  }
  return { truthByTeam }
}
let WORLD = null
const pidOf = (team) => WORLD.truthByTeam.get(team).pid
const pwOf = (team) => WORLD.truthByTeam.get(team).password
async function freeLicensesOf(team) {
  return (await fsList('licenses')).map((d) => ({ id: d.name.split('/').pop(), region: strVal(d.fields.region), owner: numVal(d.fields.owner_team), auc: strVal(d.fields.under_auction) }))
    .filter((l) => l.owner === team && l.auc == null)
}
const freeRegionOf = async (team) => (await freeLicensesOf(team))[0]?.region ?? null

// ── the invariant sweep (v3 §5–§8) — run after EVERY wave ──────────────────────────
async function sweepInvariants(label) {
  const licenses = (await fsList('licenses')).map((d) => ({ id: d.name.split('/').pop(), region: strVal(d.fields.region), owner: numVal(d.fields.owner_team), auc: strVal(d.fields.under_auction) }))
  const truths = new Map()
  for (const team of range(1, N_TEAMS)) truths.set(team, (await fsGet(`groups/team-${String(team).padStart(2, '0')}/truth/team`))?.fields ?? {})
  const groupsById = new Map()
  for (const g of await fsList('groups')) groupsById.set(numVal(g.fields.team_number), arrVal(g.fields.license_ids))

  // (1) one-owner-per-license + the full 4N licenses exist, each owned by a valid team.
  const ids = new Set(licenses.map((l) => l.id))
  const validOwners = licenses.every((l) => Number.isInteger(l.owner) && l.owner >= 1 && l.owner <= N_TEAMS)
  assert(licenses.length === LICENSE_TOTAL && ids.size === LICENSE_TOTAL && validOwners,
    `${label} · INV1 one-owner: ${licenses.length}/${LICENSE_TOTAL} licenses, all unique, all owned by a real team`)

  // (7) cash conservation — Σ cash across teams is exactly N × starting cash, always.
  let sumCash = 0, minCash = Infinity
  for (const team of range(1, N_TEAMS)) { const c = numVal(truths.get(team).cash) ?? 0; sumCash += c; minCash = Math.min(minCash, c) }
  assert(sumCash === N_TEAMS * STARTING_CASH, `${label} · INV7 cash conservation: Σcash $${sumCash} === $${N_TEAMS * STARTING_CASH}`)
  assert(minCash >= 0, `${label} · INV5 no negative cash: min team cash $${minCash}`)

  // (3)+(4) escrow == Σ of the team's OPEN-auction bids; available = cash − escrowed ≥ 0.
  const openAuc = (await fsList('auctions')).filter((a) => strVal(a.fields.status) === 'open').map((a) => a.name.split('/').pop())
  const escrowExpected = new Map()
  for (const aid of openAuc) for (const b of await fsSub(`auctions/${aid}/bids`)) { const t = numVal(b.fields.team_number); escrowExpected.set(t, (escrowExpected.get(t) ?? 0) + (numVal(b.fields.amount) ?? 0)) }
  let escrowOk = true, availOk = true
  for (const team of range(1, N_TEAMS)) {
    const esc = numVal(truths.get(team).escrowed) ?? 0
    if (esc !== (escrowExpected.get(team) ?? 0)) escrowOk = false
    if ((numVal(truths.get(team).cash) ?? 0) - esc < 0) availOk = false
  }
  assert(escrowOk, `${label} · INV3 escrow == Σ live bids across all teams (${openAuc.length} open auctions)`)
  assert(availOk, `${label} · INV4 available = cash − escrowed ≥ 0 for every team`)

  // (2) derived-cache consistency: portfolio_value == cash + Σ synergy(holdings); group.license_ids == owned set.
  const heldBy = new Map()
  for (const l of licenses) { const a = heldBy.get(l.owner) ?? []; a.push(l); heldBy.set(l.owner, a) }
  let portOk = true, cacheOk = true
  for (const team of range(1, N_TEAMS)) {
    const held = heldBy.get(team) ?? []
    const byRi = new Map()
    for (const l of held) { const ri = l.region.charCodeAt(0) - 64; byRi.set(ri, (byRi.get(ri) ?? 0) + 1) }
    let v = numVal(truths.get(team).cash) ?? 0
    for (const [ri, c] of byRi) v += valueOfHolding(assignedSchedule(team, ri, M_REGIONS), c)
    if (v !== (numVal(truths.get(team).portfolio_value) ?? 0)) portOk = false
    const ownedSet = new Set(held.map((l) => l.id)), cacheSet = new Set(groupsById.get(team) ?? [])
    if (ownedSet.size !== cacheSet.size || [...ownedSet].some((x) => !cacheSet.has(x))) cacheOk = false
  }
  assert(portOk, `${label} · INV2 portfolio_value == cash + synergy(holdings) for every team`)
  assert(cacheOk, `${label} · INV6 group.license_ids cache == licenses actually owned, every team`)
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

// ── stack lifecycle (mirrors spectrum-ledger-suite.mjs) ────────────────────────────
const children = []
function freePorts() { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 120_000) { const s = Date.now(); for (;;) { try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ } if (Date.now() - s > maxMs) throw new Error(`${label} never ready`); await sleep(600) } }
async function bringUp() {
  banner('CLEAN-START — build functions, boot emulators')
  freePorts(); await sleep(1000)
  writeFileSync(path.join(ROOT, 'functions/.env.local'), 'CLASSROOM_CALLBACK_URL=http://127.0.0.1:1/none\nCLASSROOM_ROSTER_URL=http://127.0.0.1:1/none\n')
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'shakeout-emu.log'), 'a')
  children.push(spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog] }))
  await waitHttp('http://localhost:8082/', 'firestore')
  await waitHttp('http://localhost:9002/.json', 'database')
  const s = Date.now(); for (;;) { try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ } if (Date.now() - s > 120_000) throw new Error('functions never loaded'); await sleep(800) }
  await sleep(1500); console.log('  Stack ready ✅')
}
function tearDown() { if (process.env.KEEP === '1') { console.log('\n(KEEP=1 — stack left up)'); return } for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } } freePorts() }

async function seedAndGroup() {
  banner('SEED 14 present traders → group (real endowments) → open market')
  const r = await fetch(`${FUNCTIONS}/seedMatchTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: GID, clear: true, participants: PIDS.map((id) => ({ id, role: 'trader', present: true })) }) })
  assert(r.ok, 'seedMatchTest seeded 14 present traders')
  for (const pid of PIDS) await fsPatch(`participants/${pid}`, 'display_name', { stringValue: nameOf(pid) })
  const g = await callFn('groupParticipants', asDev({ num_teams: N_TEAMS }))
  assert(g.ok && g.result?.teams_created === N_TEAMS, `groupParticipants formed ${N_TEAMS} teams (efficient value ${g.result?.efficient_market_value})`)
  // BUG 2 (live 2026-07): startMarket must honor the instructor's saved market_duration_minutes,
  // read from config/main at OPEN time — not a stale grouping-time snapshot or a hardcoded 90.
  // The instructor sets duration AFTER grouping, so we write config here (post-group) and prove
  // the opened window matches. Before the fix this came back 90 regardless.
  await fsPatch('config/main', 'market_duration_minutes', { integerValue: 10 })
  const s = await callFn('startMarket', asDev({}))
  assert(s.ok, 'startMarket opened the market')
  const windowMin = (s.result.closes_at - s.result.opened_at) / 60_000
  assert(Math.abs(windowMin - 10) < 0.5, `BUG 2: startMarket honored saved duration — window ${windowMin.toFixed(2)}min ≈ 10 (config/main), not the 90 default`)
  // Long market window (bumped down in wave 5) + short auctions so they close within the run.
  await fsPatch('market/state', 'closes_at', { timestampValue: new Date(Date.now() + 3_600_000).toISOString() })
  await fsPatch('market/state', 'auction_duration_minutes', { doubleValue: 0.2 }) // 12s
}

// count how many of a set of {ok} results succeeded
const okCount = (rs) => rs.filter((r) => r.ok).length

// ── MAIN ───────────────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()
  await seedAndGroup()
  WORLD = await readWorld()
  assert(WORLD.truthByTeam.size === N_TEAMS && range(1, N_TEAMS).every((t) => pidOf(t) && pwOf(t)), 'world read: 14 teams with pid + password')
  await sweepInvariants('BASELINE (post-group)')

  // ══ WAVE 1 — 14 teams acting AT ONCE: 7 cross deals + a same-license double-buy ══
  banner('WAVE 1 — concurrent deals across all teams + a same-license double-buy (contention)')
  {
    // Six simultaneous deals g → g+7 (each seller holds 1 in its lead region; buyer authorizes).
    // Team 1 is reserved for the double-buy below so its single license isn't also a cross deal.
    const cross = []
    for (let g = 2; g <= 7; g++) { const region = await freeRegionOf(g); if (region) cross.push(deal(pidOf(g), region, 1, 20 + g, g + 7, pwOf(g + 7))) }
    // CONTENTION: team 1 sells its (single) lead-region license to BOTH team 8 and team 9 at once.
    const r1 = await freeRegionOf(1)
    const contend = [deal(pidOf(1), r1, 1, 40, 8, pwOf(8)), deal(pidOf(1), r1, 1, 40, 9, pwOf(9))]
    const results = await Promise.all([...cross, ...contend])
    const contendResults = results.slice(cross.length)
    assert(okCount(contendResults) === 1, `WAVE1 · same-license double-buy: EXACTLY ONE of team 1's two concurrent sales of Region ${r1} wins (got ${okCount(contendResults)})`)
    log(`fired ${results.length} concurrent deals; ${okCount(results)} committed`)
  }
  await sweepInvariants('WAVE 1')

  // ══ WAVE 2 — simultaneous auctions + concurrent bidding + escrow squeeze ══
  banner('WAVE 2 — 4 simultaneous auctions, concurrent bids, an escrow squeeze')
  let auctions = []
  {
    // Four sellers open auctions AT ONCE on a free license they hold.
    const sellers = [8, 9, 10, 11]
    const created = await Promise.all(sellers.map(async (s) => { const region = await freeRegionOf(s); return region ? { s, r: await createAuction(pidOf(s), region, 1, 30) } : { s, r: { ok: false } } }))
    auctions = created.filter((c) => c.r.ok).map((c) => ({ id: c.r.result.auction_id, seller: c.s }))
    assert(auctions.length >= 3, `WAVE2 · ${auctions.length} simultaneous auctions opened`)
    // Concurrent bids: several teams bid on the auctions at once.
    const bidders = [2, 3, 4, 5, 6]
    const bids = []
    auctions.forEach((a, i) => bids.push(placeBid(pidOf(bidders[i % bidders.length]), a.id, 60 + i * 5)))
    // ESCROW SQUEEZE: team 12 (cash 1000) bids near-max on TWO auctions at once → only one can escrow.
    if (auctions.length >= 2) { bids.push(placeBid(pidOf(12), auctions[0].id, 900)); bids.push(placeBid(pidOf(12), auctions[1].id, 900)) }
    const bidResults = await Promise.all(bids)
    if (auctions.length >= 2) {
      const squeeze = bidResults.slice(-2)
      assert(okCount(squeeze) === 1, `WAVE2 · escrow squeeze: team 12's two concurrent $900 bids — only ONE escrows (got ${okCount(squeeze)}); available can't back both`)
    }
    log(`fired ${bidResults.length} concurrent bids; ${okCount(bidResults)} accepted`)
  }
  await sweepInvariants('WAVE 2 (auctions open)')

  // ══ WAVE 3 — auctions CLOSE (Cloud Task + backstop) WHILE fresh deals fire ══
  banner('WAVE 3 — auctions settling (task + backstop) while new deals fire concurrently')
  {
    log('waiting ~13s for the 12s auctions to end…'); await sleep(13_000)
    // In ONE concurrent burst: fire the Cloud Task AND the resolve-on-read backstop for every
    // auction, AND a handful of fresh deals among uninvolved teams — all racing together.
    const closing = auctions.flatMap((a) => [fireCloudTask(a.id), getAuctionState(pidOf(a.seller), a.id)])
    const freshDeals = []
    for (const g of [3, 4, 5, 6]) { const region = await freeRegionOf(g); if (region) freshDeals.push(deal(pidOf(g), region, 1, 15, g === 6 ? 1 : g + 1, pwOf(g === 6 ? 1 : g + 1))) }
    await Promise.all([...closing, ...freshDeals])
    // The Cloud-Task handler + resolve-on-read backstop settle ASYNCHRONOUSLY — poll until every
    // auction is resolved (settled / no_sale), up to ~9s, before asserting (mirrors the S5 poll).
    const resolvedOf = async (id) => { const st = strVal((await fsGet(`auctions/${id}`))?.fields?.status); return st === 'settled' || st === 'no_sale' }
    // Poll up to ~18s: the Cloud-Task handler + resolve-on-read backstop settle asynchronously and,
    // under emulator load, occasionally exceed the old 9s window (the auctions DO resolve — the
    // pre-reconciliation "0 still open" check and exact reconciliation confirm it — just later). A
    // genuinely stuck auction still fails well within 18s; this only removes a load-timing flake.
    let polls = 0
    for (let i = 0; i < 60; i++) { polls = i + 1; const states = await Promise.all(auctions.map((a) => resolvedOf(a.id))); if (states.every(Boolean)) break; await sleep(300) }
    const finalStates = await Promise.all(auctions.map(async (a) => strVal((await fsGet(`auctions/${a.id}`))?.fields?.status)))
    log(`WAVE3 poll: ${polls} iters (~${(polls * 0.3).toFixed(1)}s) · statuses ${JSON.stringify(finalStates)}`)
    // Every auction must be resolved exactly once (settled or no_sale), each with ≤1 auction event.
    let allResolved = true, oneEventEach = true
    for (const a of auctions) {
      if (!(await resolvedOf(a.id))) allResolved = false
      const evs = (await fsList('transactions')).filter((d) => strVal(d.fields.auction_id) === a.id)
      if (evs.length > 1) oneEventEach = false
    }
    assert(allResolved, 'WAVE3 · every auction resolved (settled / no_sale) despite the concurrent close race')
    assert(oneEventEach, 'WAVE3 · each auction produced AT MOST ONE settlement event (no double-settle under the race)')
  }
  await sweepInvariants('WAVE 3')

  // ══ WAVE 4 — concurrent swaps overlapping with deals (atomicity under contention) ══
  banner('WAVE 4 — concurrent swaps + a swap racing a deal on the same license')
  {
    const ops = []
    // Clean concurrent swaps between disjoint pairs.
    for (const [a, b] of [[2, 3], [4, 5], [6, 7]]) {
      const ra = await freeRegionOf(a), rb = await freeRegionOf(b)
      if (ra && rb && ra !== rb) ops.push(swap(pidOf(a), ra, 1, rb, 1, b, pwOf(b)))
    }
    // CONTENTION: team 10 swaps a license to team 13 while team 14 concurrently buys that same license.
    const r10 = await freeRegionOf(10)
    if (r10) {
      const before = ops.length
      ops.push(swap(pidOf(10), r10, 1, await freeRegionOf(13) ?? r10, 1, 13, pwOf(13)))
      ops.push(deal(pidOf(10), r10, 1, 25, 14, pwOf(14)))
      const results = await Promise.all(ops)
      const contend = results.slice(before)
      assert(okCount(contend) === 1, `WAVE4 · swap-vs-deal on the same Region ${r10} license: EXACTLY ONE wins (got ${okCount(contend)}), never half a swap`)
    } else { await Promise.all(ops) }
    log('concurrent swaps + swap-vs-deal contention fired')
  }
  await sweepInvariants('WAVE 4')

  // ══ WAVE 5 — HARD CLOSE fires with a burst of actions queued ══
  banner('WAVE 5 — hard close with actions in flight: everything past the deadline is rejected cleanly')
  {
    const licBefore = (await fsList('licenses')).map((d) => `${d.name.split('/').pop()}:${numVal(d.fields.owner_team)}`).sort().join(',')
    const txBefore = (await fsList('transactions')).length
    // Move the deadline into the PAST, then fire a concurrent burst as if teams were mid-action.
    await fsPatch('market/state', 'closes_at', { timestampValue: new Date(Date.now() - 2000).toISOString() })
    const burst = []
    for (const g of [1, 2, 3, 4, 5]) { const region = await freeRegionOf(g); if (region) { burst.push(deal(pidOf(g), region, 1, 30, g + 7, pwOf(g + 7))); burst.push(swap(pidOf(g), region, 1, await freeRegionOf(g + 7) ?? region, 1, g + 7, pwOf(g + 7))) } }
    burst.push(createAuction(pidOf(9), await freeRegionOf(9) ?? 'A', 1, 50))
    const results = await Promise.all(burst)
    const rejected = results.filter((r) => !r.ok).length
    const closedMsg = results.filter((r) => !r.ok && /market has closed|not open|market closes/i.test(r.error ?? '')).length
    assert(rejected === results.length, `WAVE5 · every one of the ${results.length} in-flight actions past the deadline was REJECTED (none half-applied): ${rejected}/${results.length}`)
    assert(closedMsg >= 1, `WAVE5 · rejections cite the closed/over-deadline market (${closedMsg} explicit)`)
    const licAfter = (await fsList('licenses')).map((d) => `${d.name.split('/').pop()}:${numVal(d.fields.owner_team)}`).sort().join(',')
    const txAfter = (await fsList('transactions')).length
    assert(licAfter === licBefore && txAfter === txBefore, `WAVE5 · NOTHING moved after the deadline (ownership + transaction count unchanged)`)
    const gm = await getMarketState()
    assert(gm.ok && gm.result.status === 'closed', `WAVE5 · getMarketState flips the market → closed [${gm.result?.status}]`)
  }
  await sweepInvariants('WAVE 5 (post hard-close)')

  // ── Settle any remaining open auctions so there are no live holds, then final sweep. ──
  banner('SETTLE stragglers → final invariant sweep')
  {
    const open = (await fsList('auctions')).filter((a) => strVal(a.fields.status) === 'open').map((a) => a.name.split('/').pop())
    for (const aid of open) { await fireCloudTask(aid); await settle(aid) }
    await sleep(1500)
    const stillOpen = (await fsList('auctions')).filter((a) => strVal(a.fields.status) === 'open').length
    assert(stillOpen === 0, `all auctions resolved before reconciliation (${stillOpen} still open)`)
  }
  await sweepInvariants('FINAL')

  // ══ THE NAMED ASSERTION (v3 §15) — LEDGER RECONCILIATION ══
  banner('RECONCILIATION — replay the full transaction log from the endowments → match live EXACTLY')
  {
    const txCount = (await fsList('transactions')).length
    log(`live market has ${txCount} committed transactions; replaying from the generated endowments…`)
    // reconcile() uses firebase-admin against the SAME emulator (FIRESTORE_EMULATOR_HOST set below).
    const r = await reconcile({ projectId: PROJECT, gid: GID, log: (m) => console.log(m) })
    assert(r.ok, `RECONCILIATION: replayed state matches live state EXACTLY — license-for-license, dollar-for-dollar (${r.pass} checks passed${r.fail ? `, ${r.fail} FAILED` : ''})`)
  }

  banner(`RESULT — ${PASS}/${PASS + FAIL} green${FAIL ? `  (${FAIL} FAILED)` : ''}`)
}

// Point firebase-admin (used by reconcile) at the emulator BEFORE it initializes.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'

;(async () => {
  try { await main() }
  catch (err) { FAIL++; console.error('\n✗ FATAL:', err?.stack ?? err) }
  finally { console.log(`\nDONE — ${PASS} passed, ${FAIL} failed`); tearDown(); process.exit(FAIL ? 1 : 0) }
})()
