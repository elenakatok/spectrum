/**
 * Spectrum SLICE 1 — the pure ledger CONCURRENCY suite (backend-only; no browser).
 *
 * The legacy audit's lesson: casual tests pass on broken code. This suite is the
 * deliverable. It boots the emulator, seeds an exact ledger state per test via the
 * seedLedgerTest function, fires the ledger callables CONCURRENTLY over HTTP, and
 * asserts every invariant — especially cash conservation after EVERY test.
 *
 *   node spectrum-ledger-suite.mjs      (env: KEEP=1 to leave the stack up on exit)
 */

import { openSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT   = 'spectrum-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const PORTS     = [9101, 5005, 8082, 9002]
const GID       = process.env.GID ?? `led-${Date.now()}`

// ── tiny harness ────────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(70) + '\n' + m + '\n' + '─'.repeat(70))
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else      { FAIL++; console.log(`  ✗ FAILED: ${name}`) }
}

// ── callable + Firestore REST helpers ─────────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}
const deal  = (pid, region, quantity, price, buyerTeam, buyerPassword) =>
  callFn('executeDeal', { _test: { participant_id: pid, game_instance_id: GID }, region, quantity, price, buyerTeam, buyerPassword })
const swap  = (pid, regionX, quantityX, regionY, quantityY, partnerTeam, partnerPassword) =>
  callFn('executeSwap', { _test: { participant_id: pid, game_instance_id: GID }, regionX, quantityX, regionY, quantityY, partnerTeam, partnerPassword })
const settle = (auctionId) =>
  callFn('settleAuction', { _dev: { game_instance_id: GID }, auction_id: auctionId })
// Slice 2 lifecycle callables
const createAuction = (pid, region, quantity, reserve) =>
  callFn('createAuction', { _test: { participant_id: pid, game_instance_id: GID }, region, quantity, reserve })
const placeBid = (pid, auctionId, amount) =>
  callFn('placeBid', { _test: { participant_id: pid, game_instance_id: GID }, auction_id: auctionId, amount })
const getAuctionState = (pid, auctionId) =>
  callFn('getAuctionState', { _test: { participant_id: pid, game_instance_id: GID }, auction_id: auctionId })
// The PRIMARY close trigger — invoke the Cloud Task handler's emulator HTTP endpoint directly
// (the same onTaskDispatched handler Cloud Tasks would invoke → the same runSettlement core).
async function fireCloudTask(auctionId) {
  const res = await fetch(`${FUNCTIONS}/settleAuctionTask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { game_instance_id: GID, auction_id: auctionId } }),
  })
  return { status: res.status, body: await res.text().catch(() => '') }
}

async function fsGet(suffix) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${suffix}`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return null
  return res.json()
}
async function fsList(collection) {
  const res = await fetch(`${FIRESTORE}/game_instances/${GID}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return []
  return (await res.json()).documents ?? []
}
const numVal = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue != null ? f.doubleValue : null))
const strVal = f => f?.stringValue ?? null
const arrVal = f => (f?.arrayValue?.values ?? []).map(v => v.stringValue)

async function truth(team) {
  const d = await fsGet(`groups/team-${team}/truth/team`)
  if (!d?.fields) return null
  return {
    cash: numVal(d.fields.cash),
    escrowed: numVal(d.fields.escrowed),
    license_ids: arrVal(d.fields.license_ids),
    portfolio_value: numVal(d.fields.portfolio_value),
  }
}
async function license(id) {
  const d = await fsGet(`licenses/${id}`)
  if (!d?.fields) return null
  return { owner_team: numVal(d.fields.owner_team), under_auction: strVal(d.fields.under_auction) }
}
async function heldInRegion(team, region) {
  const docs = await fsList('licenses')
  return docs.filter(d => numVal(d.fields.owner_team) === team && strVal(d.fields.region) === region).length
}
async function txns() {
  const docs = await fsList('transactions')
  return docs.map(d => ({
    type: strVal(d.fields.type),
    from: numVal(d.fields.from_team), to: numVal(d.fields.to_team),
    price: numVal(d.fields.price),
  }))
}
async function auction(id) {
  const d = await fsGet(`auctions/${id}`)
  if (!d?.fields) return null
  return {
    status: strVal(d.fields.status), winner_team: numVal(d.fields.winner_team),
    clearing_price: numVal(d.fields.clearing_price),
    under_auction: null, reserve: numVal(d.fields.reserve),
  }
}
async function licenseUnderAuction(id) { return (await license(id))?.under_auction ?? null }
async function auctionEventCount() { return (await txns()).filter(t => t.type === 'auction').length }
async function totalCash(teams) {
  let sum = 0
  for (const t of teams) sum += (await truth(t))?.cash ?? 0
  return sum
}

async function seed(spec) {
  const res = await fetch(`${FUNCTIONS}/seedLedgerTest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: GID, ...spec }),
  })
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
}

// Assert exactly one of the two settled results succeeded; return {winner, loser}.
function exactlyOne(a, b, label) {
  const oks = [a, b].filter(r => r.ok).length
  assert(oks === 1, `${label}: exactly one call succeeds (got ${oks} — [${a.ok ? 'ok' : a.error}] / [${b.ok ? 'ok' : b.error}])`)
  return { winnerIsA: a.ok }
}

// ── stack lifecycle ───────────────────────────────────────────────────────────────
const children = []
function freePorts() { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} never ready`)
    await sleep(600)
  }
}
async function bringUp() {
  banner('CLEAN-START — build functions, boot emulators (functions/firestore/database/auth)')
  freePorts(); await sleep(1000)
  writeFileSync(path.join(ROOT, 'functions/.env.local'),
    'CLASSROOM_CALLBACK_URL=http://127.0.0.1:1/receiveGameResult\nCLASSROOM_ROSTER_URL=http://127.0.0.1:1/getCourseRoster\n')
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'ledger-emu.log'), 'a')
  const child = spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT],
    { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog] })
  children.push(child)
  await waitHttp('http://localhost:8082/', 'firestore')
  await waitHttp('http://localhost:9002/.json', 'database')
  // `health` is a real onRequest function — a 200 means the functions are actually LOADED
  // (the emulator hub 404s every path until load completes, so a bare reachability check
  // false-passes). Poll for the real 200 before proceeding.
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ }
    if (Date.now() - start > 120_000) throw new Error('functions never finished loading')
    await sleep(800)
  }
  await sleep(1500)
  console.log('  Stack ready ✅ (functions loaded)')
}
function tearDown() { if (process.env.KEEP === '1') return; for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } } freePorts() }

// pw helper
const PW = n => `pw${n}`

// ── the suite ─────────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()

  // ══ T1 — Same-license double-sell (THE NAMED ASSERTION) ══
  banner('T1 — Same-license double-sell: A sells the same 3 of Region C to B and D at once')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) },
        { team_number: 4, members: ['p-4'], cash: 10000, password: PW(4) },
      ],
      licenses: [
        { id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 }, { id: 'C3', region: 'C', owner_team: 1 },
      ],
    })
    const total0 = await totalCash([1, 2, 4]) // 21000
    const [rB, rD] = await Promise.all([
      deal('p-1', 'C', 3, 300, 2, PW(2)),
      deal('p-1', 'C', 3, 300, 4, PW(4)),
    ])
    exactlyOne(rB, rD, 'T1')
    const t = await txns()
    assert(t.length === 1, `T1: exactly ONE transaction event exists (got ${t.length})`)
    // The loser's money never moved.
    const b = await truth(2), d = await truth(4)
    const paidCount = [b.cash, d.cash].filter(c => c === 9700).length
    const untouched = [b.cash, d.cash].filter(c => c === 10000).length
    assert(paidCount === 1 && untouched === 1, `T1: exactly one buyer paid 300, the other's money NEVER moved [B=${b.cash} D=${d.cash}]`)
    assert((await heldInRegion(1, 'C')) === 0, `T1: seller sold the 3 licenses exactly once (holds 0 in C)`)
    const total1 = await totalCash([1, 2, 4])
    assert(total1 === total0, `T1: CASH CONSERVATION Σ=${total1} === ${total0}`)
  }

  // ══ T2 — Sell more than you hold ══
  banner('T2 — Sell more than you hold: holds 3 in C, fires two concurrent deals of 2')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 }, { id: 'C3', region: 'C', owner_team: 1 }],
    })
    const total0 = await totalCash([1, 2])
    const [r1, r2] = await Promise.all([deal('p-1', 'C', 2, 200, 2, PW(2)), deal('p-1', 'C', 2, 200, 2, PW(2))])
    exactlyOne(r1, r2, 'T2')
    assert((await heldInRegion(1, 'C')) === 1 && (await heldInRegion(2, 'C')) === 2,
      `T2: NEVER 4 licenses out of a 3-holding (seller 1 left, buyer 2)`)
    assert((await txns()).length === 1, `T2: exactly one event`)
    assert((await totalCash([1, 2])) === total0, `T2: CASH CONSERVATION`)
  }

  // ══ T3 — Deficit race ══
  banner('T3 — Deficit race: buyer B has $500 available, two concurrent $400 purchases')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 3, members: ['p-3'], cash: 1000, password: PW(3) },
        { team_number: 2, members: ['p-2'], cash: 500, password: PW(2) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'D1', region: 'D', owner_team: 3 }],
    })
    const total0 = await totalCash([1, 2, 3])
    const [r1, r2] = await Promise.all([deal('p-1', 'C', 1, 400, 2, PW(2)), deal('p-3', 'D', 1, 400, 2, PW(2))])
    exactlyOne(r1, r2, 'T3')
    const b = await truth(2)
    assert(b.cash === 100, `T3: buyer cash never goes negative, exactly one $400 debit [cash=${b.cash}]`)
    assert((await txns()).length === 1, `T3: exactly one event`)
    assert((await totalCash([1, 2, 3])) === total0, `T3: CASH CONSERVATION`)
  }

  // ══ T4 — Escrow vs deal (reject, then release, then succeed) ══
  banner('T4 — Escrow: $500 cash − $400 escrowed = $100 avail → $300 deal rejects; release → succeeds')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 500, escrowed: 400, password: PW(2) },
        { team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 600, license_ids: ['G1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 2, amount: 400, at_ms: 100 }],
    })
    const total0 = await totalCash([1, 2, 9])
    const r1 = await deal('p-1', 'C', 1, 300, 2, PW(2))
    assert(!r1.ok && /sufficient available funds/.test(r1.error ?? ''), `T4a: $300 deal REJECTED while $400 escrowed [${r1.error}]`)
    assert((await truth(2)).cash === 500, `T4a: rejected deal moved no money`)
    const rs = await settle('A')
    assert(rs.ok && rs.result.status === 'no_sale', `T4b: auction (bid 400 < reserve 600) settles no_sale → escrow released`)
    assert((await truth(2)).escrowed === 0, `T4b: team 2 escrow released to 0`)
    assert((await license('G1')).under_auction === null, `T4b: G1 license lock lifted`)
    const r2 = await deal('p-1', 'C', 1, 300, 2, PW(2))
    assert(r2.ok, `T4c: after release, the same $300 deal SUCCEEDS`)
    assert((await truth(2)).cash === 200, `T4c: buyer paid 300 (cash 500→200)`)
    assert((await totalCash([1, 2, 9])) === total0, `T4: CASH CONSERVATION`)
  }

  // ══ T5 — Double-submit replay ══
  banner('T5 — Double-submit replay: the identical deal fired twice → exactly one event')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 }, { id: 'C3', region: 'C', owner_team: 1 }],
    })
    const total0 = await totalCash([1, 2])
    const [r1, r2] = await Promise.all([deal('p-1', 'C', 3, 300, 2, PW(2)), deal('p-1', 'C', 3, 300, 2, PW(2))])
    exactlyOne(r1, r2, 'T5')
    assert((await txns()).length === 1, `T5: exactly ONE event (no double-charge on replay)`)
    assert((await truth(2)).cash === 9700, `T5: buyer charged exactly once`)
    assert((await totalCash([1, 2])) === total0, `T5: CASH CONSERVATION`)
  }

  // ══ T6a — Swap correctness ══
  banner('T6a — Swap: 1 of Region C ↔ 1 of Region D, no cash, one event')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 1000, password: PW(2) },
      ],
      licenses: [
        { id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 },
        { id: 'D1', region: 'D', owner_team: 2 }, { id: 'D2', region: 'D', owner_team: 2 },
      ],
    })
    const total0 = await totalCash([1, 2])
    const r = await swap('p-1', 'C', 1, 'D', 1, 2, PW(2))
    assert(r.ok, `T6a: swap succeeds`)
    assert((await heldInRegion(1, 'C')) === 1 && (await heldInRegion(1, 'D')) === 1, `T6a: initiator now holds 1 C + 1 D (both legs landed)`)
    assert((await heldInRegion(2, 'C')) === 1 && (await heldInRegion(2, 'D')) === 1, `T6a: partner now holds 1 C + 1 D (both legs landed)`)
    const t = await txns()
    assert(t.length === 1 && t[0].type === 'swap' && t[0].price === null, `T6a: exactly one swap event, no price`)
    assert((await totalCash([1, 2])) === total0 && (await truth(1)).cash === 1000, `T6a: no cash moved`)
  }

  // ══ T6b — Swap atomicity vs concurrent deal on the same license ══
  banner('T6b — Swap atomicity: swap a C license while concurrently selling both C → exactly one, never half a swap')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 1000, password: PW(2) },
        { team_number: 3, members: ['p-3'], cash: 10000, password: PW(3) },
      ],
      licenses: [
        { id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 },
        { id: 'D1', region: 'D', owner_team: 2 },
      ],
    })
    const total0 = await totalCash([1, 2, 3])
    const [rSwap, rDeal] = await Promise.all([
      swap('p-1', 'C', 1, 'D', 1, 2, PW(2)),   // give 1 C, get 1 D from team 2
      deal('p-1', 'C', 2, 500, 3, PW(3)),        // sell BOTH C to team 3
    ])
    exactlyOne(rSwap, rDeal, 'T6b')
    if (rSwap.ok) {
      assert((await heldInRegion(2, 'C')) === 1 && (await heldInRegion(1, 'D')) === 1 && (await heldInRegion(1, 'C')) === 1,
        `T6b: swap won → BOTH legs landed (partner +1 C, initiator +1 D), no half-swap`)
    } else {
      assert((await heldInRegion(3, 'C')) === 2 && (await heldInRegion(2, 'C')) === 0,
        `T6b: deal won → swap left NO trace (partner never received a C)`)
    }
    assert((await totalCash([1, 2, 3])) === total0, `T6b: CASH CONSERVATION`)
  }

  // ══ T7 — Auction license lock ══
  banner('T7 — Auction lock: a license under a live auction cannot be sold or swapped')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) },
        { team_number: 3, members: ['p-3'], cash: 10000, password: PW(3) },
      ],
      licenses: [
        { id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' },
        { id: 'D1', region: 'D', owner_team: 2 },
      ],
      auctions: [{ id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['C1'], ends_at_ms: 9_999_999_999_999, status: 'open' }],
    })
    const rDeal = await deal('p-1', 'C', 1, 100, 3, PW(3))
    assert(!rDeal.ok && /under auction/.test(rDeal.error ?? ''), `T7: selling an auction-locked license is REJECTED [${rDeal.error}]`)
    const rSwap = await swap('p-1', 'C', 1, 'D', 1, 2, PW(2))
    assert(!rSwap.ok && /under auction/.test(rSwap.error ?? ''), `T7: swapping an auction-locked license is REJECTED [${rSwap.error}]`)
    assert((await license('C1')).owner_team === 1, `T7: the locked license never moved (still team 1)`)
    // (re-auction rejection uses the same under_auction check; createAuction is Slice 2.)
  }

  // ══ T8 — Double-settle ══
  banner('T8 — Double-settle: settleAuction fired twice concurrently → winner charged once, one event')
  {
    await seed({
      teams: [
        { team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) },
        { team_number: 2, members: ['p-2'], cash: 10000, escrowed: 500, password: PW(2) },
      ],
      licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 100, license_ids: ['G1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 2, amount: 500, at_ms: 100 }],
    })
    const total0 = await totalCash([2, 9])
    const [s1, s2] = await Promise.all([settle('A'), settle('A')])
    const settledOk = [s1, s2].filter(r => r.ok).length
    assert(settledOk === 2, `T8: both concurrent calls return ok (one settles, one is idempotent no-op) [${s1.ok}/${s2.ok}]`)
    const oneSettled = [s1, s2].filter(r => r.ok && r.result.alreadySettled === false).length
    const oneNoop = [s1, s2].filter(r => r.ok && r.result.alreadySettled === true).length
    assert(oneSettled === 1 && oneNoop === 1, `T8: exactly one did the work, one was idempotent [settled=${oneSettled} noop=${oneNoop}]`)
    assert((await truth(2)).cash === 9500, `T8: winner charged EXACTLY once (10000→9500, not 9000)`)
    assert((await truth(9)).cash === 1500, `T8: seller paid EXACTLY once (1000→1500)`)
    assert((await truth(2)).escrowed === 0, `T8: winner escrow released once`)
    assert((await license('G1')).owner_team === 2, `T8: the lot moved to the winner`)
    const at = await txns()
    assert(at.length === 1 && at[0].type === 'auction', `T8: exactly ONE auction event (the legacy double-charge, impossible)`)
    assert((await auction('A')).status === 'settled', `T8: auction status settled`)
    assert((await totalCash([2, 9])) === total0, `T8: CASH CONSERVATION`)
  }

  // ══ T9 — Password rejection (+ case-insensitive/trimmed acceptance) ══
  banner('T9 — Password: wrong / wrong-team / non-party all rejected; correct (case+space) accepted')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: 'Correct2' },
        { team_number: 5, members: ['p-5'], cash: 10000, password: PW(5) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 }],
    })
    const total0 = await totalCash([1, 2, 5])
    const rWrong = await deal('p-1', 'C', 1, 100, 2, 'totally-wrong')
    assert(!rWrong.ok && /Password not recognized/.test(rWrong.error ?? ''), `T9a: wrong password rejected (non-leaking) [${rWrong.error}]`)
    const rOtherTeam = await deal('p-1', 'C', 1, 100, 2, PW(5))
    assert(!rOtherTeam.ok && /Password not recognized/.test(rOtherTeam.error ?? ''), `T9b: another team's password (team 5's) for a team-2 deal rejected`)
    const rGood = await deal('p-1', 'C', 1, 100, 2, '  CORRECT2 ')
    assert(rGood.ok, `T9c: correct password accepted case-insensitively + whitespace-trimmed ('  CORRECT2 ')`)
    assert((await txns()).length === 1, `T9: exactly one event (only the authorized deal)`)
    assert((await totalCash([1, 2, 5])) === total0, `T9: CASH CONSERVATION`)
  }

  // ══════════════════════ SLICE 2 — AUCTION LIFECYCLE ══════════════════════
  banner('════ SLICE 2 — auction lifecycle (Slice 1 above is now regression) ════')

  // ══ S1 — createAuction: locks the lot, sets it live ══
  banner('S1 — createAuction locks the lot and goes live')
  {
    await seed({
      closes_in_ms: 1_200_000, auction_duration_minutes: 4,
      teams: [{ team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) }],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'C2', region: 'C', owner_team: 1 }, { id: 'C3', region: 'C', owner_team: 1 }],
    })
    const r = await createAuction('p-1', 'C', 2, 500)
    assert(r.ok && typeof r.result.auction_id === 'string', `S1: createAuction succeeds [${r.ok ? 'ok' : r.error}]`)
    const aid = r.result?.auction_id
    const a = await auction(aid)
    assert(a?.status === 'open', `S1: auction is open`)
    assert((await licenseUnderAuction('C1')) === aid && (await licenseUnderAuction('C2')) === aid, `S1: the 2 licenses are locked under this auction`)
    assert((await licenseUnderAuction('C3')) === null, `S1: the un-listed license stays free`)
  }

  // ══ S2 — cutoff rule (end-to-end; exact boundary is in the unit test) ══
  banner('S2 — cutoff rule: auction must finish ≥5 min before market close')
  {
    // ACCEPT: closes in 10 min, 4-min auction ends at +4 min, cutoff at close−5 = +5 min → +4 ≤ +5.
    await seed({
      closes_in_ms: 600_000, auction_duration_minutes: 4,
      teams: [{ team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) }],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }, { id: 'D1', region: 'D', owner_team: 1 }],
    })
    const rOk = await createAuction('p-1', 'C', 1, 0)
    assert(rOk.ok, `S2a: closes_in=10min, 4-min auction ACCEPTED (ends +4min ≤ cutoff +5min) [${rOk.ok ? 'ok' : rOk.error}]`)
    // REJECT: closes in 8 min → cutoff at +3 min, 4-min auction ends at +4 min > +3 min.
    await seed({
      closes_in_ms: 480_000, auction_duration_minutes: 4,
      teams: [{ team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) }],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }],
    })
    const rNo = await createAuction('p-1', 'C', 1, 0)
    assert(!rNo.ok && /cannot finish before the market closes/.test(rNo.error ?? ''), `S2b: closes_in=8min REJECTED (ends +4min > cutoff +3min) [${rNo.error}]`)
  }

  // ══ S3 — placeBid + escrow + one-bid-per-team ══
  banner('S3 — placeBid escrows; one bid per team; two live bids cannot promise the same dollar')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 500, password: PW(2) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' }, { id: 'D1', region: 'D', owner_team: 1, under_auction: 'B' }],
      auctions: [
        { id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['C1'], ends_at_ms: 9_999_999_999_999, status: 'open' },
        { id: 'B', region: 'D', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['D1'], ends_at_ms: 9_999_999_999_999, status: 'open' },
      ],
    })
    const total0 = await totalCash([1, 2])
    const r1 = await placeBid('p-2', 'A', 300)
    assert(r1.ok, `S3a: bid 300 accepted [${r1.ok ? 'ok' : r1.error}]`)
    assert((await truth(2)).escrowed === 300, `S3a: escrow rose to 300 (available 500→200)`)
    const r2 = await placeBid('p-2', 'A', 250)
    assert(!r2.ok && /already bid/.test(r2.error ?? ''), `S3b: a SECOND bid on the same auction is rejected (no revisions) [${r2.error}]`)
    const r3 = await placeBid('p-2', 'B', 300)
    assert(!r3.ok && /sufficient available funds/.test(r3.error ?? ''), `S3c: a second LIVE bid ($300) with only $200 available is rejected (can't promise the same dollar twice) [${r3.error}]`)
    assert((await totalCash([1, 2])) === total0, `S3: CASH CONSERVATION (escrow is not a cash move)`)
  }

  // ══ S4 — bid guards ══
  banner('S4 — bid guards: seller can\'t bid, no bids on ended auctions, amount > 0')
  {
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' }, { id: 'D1', region: 'D', owner_team: 1, under_auction: 'E' }],
      auctions: [
        { id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['C1'], ends_at_ms: 9_999_999_999_999, status: 'open' },
        { id: 'E', region: 'D', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['D1'], ends_at_ms: 1000, status: 'open' }, // already ended
      ],
    })
    const rSelf = await placeBid('p-1', 'A', 200)
    assert(!rSelf.ok && /own auction/.test(rSelf.error ?? ''), `S4a: seller bidding on own auction rejected [${rSelf.error}]`)
    const rEnded = await placeBid('p-2', 'E', 200)
    assert(!rEnded.ok && /ended/.test(rEnded.error ?? ''), `S4b: bidding on an ended auction rejected (backstop settles it first) [${rEnded.error}]`)
    const rZero = await placeBid('p-2', 'A', 0)
    assert(!rZero.ok, `S4c: a non-positive bid amount is rejected`)
  }

  // ══ S5 — CLOSE MECHANICS: Cloud Task, backstop, both racing (NAMED ASSERTION) ══
  banner('S5 — close: task alone / backstop alone / BOTH concurrent (named) / settled-touched-again')
  const auctionSeed = () => ({
    teams: [
      { team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) },
      { team_number: 2, members: ['p-2'], cash: 10000, escrowed: 500, password: PW(2) },
    ],
    licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
    auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 100, license_ids: ['G1'], ends_at_ms: 1000 }],
    bids: [{ auction_id: 'A', team_number: 2, amount: 500, at_ms: 100 }],
  })
  {
    // Backstop alone (Cloud Task never arrives — simulate failure): getAuctionState settles it.
    await seed(auctionSeed())
    const gs = await getAuctionState('p-2', 'A')
    assert(gs.ok, `S5-backstop: getAuctionState on an ended auction succeeds (resolve-on-read)`)
    assert((await auction('A')).status === 'settled' && (await truth(2)).cash === 9500, `S5-backstop: BACKSTOP ALONE settled it (winner charged once)`)
  }
  {
    // Cloud Task alone: invoke the task handler → settles.
    await seed(auctionSeed())
    const ct = await fireCloudTask('A')
    // wait briefly for the async settle
    for (let i = 0; i < 20 && (await auction('A')).status !== 'settled'; i++) await sleep(300)
    assert((await auction('A')).status === 'settled' && (await truth(2)).cash === 9500,
      `S5-task: CLOUD TASK ALONE settled it via the settleAuctionTask handler [http ${ct.status}]`)
  }
  {
    // NAMED ASSERTION — both fire concurrently → settles exactly once.
    await seed(auctionSeed())
    const total0 = await totalCash([2, 9])
    const [ct, gs] = await Promise.all([fireCloudTask('A'), getAuctionState('p-2', 'A')])
    for (let i = 0; i < 20 && (await auction('A')).status !== 'settled'; i++) await sleep(300)
    void ct; void gs
    assert((await auction('A')).status === 'settled', `S5-NAMED: both paths racing → auction settled`)
    assert((await truth(2)).cash === 9500, `S5-NAMED: winner charged EXACTLY once (10000→9500, not 9000)`)
    assert((await truth(9)).cash === 1500, `S5-NAMED: seller paid EXACTLY once (1000→1500)`)
    assert((await auctionEventCount()) === 1, `S5-NAMED: exactly ONE auction transaction event (double-settle impossible)`)
    assert((await truth(2)).escrowed === 0, `S5-NAMED: winner escrow released once`)
    assert((await totalCash([2, 9])) === total0, `S5-NAMED: CASH CONSERVATION`)
    // Touch again after settlement → no-op.
    await getAuctionState('p-2', 'A'); await fireCloudTask('A'); await sleep(400)
    assert((await truth(2)).cash === 9500 && (await auctionEventCount()) === 1, `S5-again: a settled auction touched again → no-op, no second charge, no second event`)
  }

  // ══ S6 — settlement rules via the lifecycle ══
  banner('S6 — settlement rules: at-reserve WINS (named secondary), below-reserve no-sale, ties, no bids')
  {
    // At-reserve WINS (SECONDARY NAMED ASSERTION).
    await seed({
      teams: [{ team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) }, { team_number: 2, members: ['p-2'], cash: 10000, escrowed: 500, password: PW(2) }],
      licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 500, license_ids: ['G1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 2, amount: 500, at_ms: 100 }],
    })
    await getAuctionState('p-2', 'A')
    const a = await auction('A')
    assert(a.status === 'settled' && a.winner_team === 2 && a.clearing_price === 500, `S6-at-reserve: a bid EXACTLY at reserve WINS (legacy voided it) [status=${a.status} winner=${a.winner_team} price=${a.clearing_price}]`)
    assert((await license('G1')).owner_team === 2, `S6-at-reserve: lot moved to the at-reserve winner`)
  }
  {
    // One cent below reserve → no sale, licenses freed, escrow released.
    await seed({
      teams: [{ team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) }, { team_number: 2, members: ['p-2'], cash: 10000, escrowed: 499, password: PW(2) }],
      licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 500, license_ids: ['G1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 2, amount: 499, at_ms: 100 }],
    })
    const total0 = await totalCash([2, 9])
    await getAuctionState('p-2', 'A')
    assert((await auction('A')).status === 'no_sale', `S6-below: one cent below reserve → NO SALE`)
    assert((await license('G1')).owner_team === 9 && (await license('G1')).under_auction === null, `S6-below: license returns to seller, freed`)
    assert((await truth(2)).escrowed === 0, `S6-below: escrow released (cash comes back)`)
    assert((await totalCash([2, 9])) === total0, `S6-below: CASH CONSERVATION`)
  }
  {
    // Ties → earliest bid wins.
    await seed({
      teams: [
        { team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) },
        { team_number: 2, members: ['p-2'], cash: 10000, escrowed: 500, password: PW(2) },
        { team_number: 3, members: ['p-3'], cash: 10000, escrowed: 500, password: PW(3) },
      ],
      licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 100, license_ids: ['G1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 3, amount: 500, at_ms: 250 }, { auction_id: 'A', team_number: 2, amount: 500, at_ms: 100 }],
    })
    await getAuctionState('p-9', 'A')
    assert((await auction('A')).winner_team === 2, `S6-tie: equal bids → EARLIEST (team 2 @100ms) wins over team 3 @250ms`)
  }
  {
    // No bids at all → no sale, freed.
    await seed({
      teams: [{ team_number: 9, members: ['p-9'], cash: 1000, password: PW(9) }],
      licenses: [{ id: 'G1', region: 'G', owner_team: 9, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'G', quantity: 1, seller_team: 9, reserve: 100, license_ids: ['G1'], ends_at_ms: 1000 }],
    })
    await getAuctionState('p-9', 'A')
    assert((await auction('A')).status === 'no_sale' && (await license('G1')).under_auction === null, `S6-nobids: no bids → no sale, license freed`)
  }

  // ══ S7 — locks: re-auction rejected (Slice 1 T7 completion); freed after settle ══
  banner('S7 — re-auction of a locked license rejected; freely tradeable again after settlement')
  {
    await seed({
      closes_in_ms: 1_200_000,
      teams: [{ team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) }, { team_number: 2, members: ['p-2'], cash: 10000, password: PW(2) }],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: 100, license_ids: ['C1'], ends_at_ms: 1000 }],
    })
    const rRe = await createAuction('p-1', 'C', 1, 0)
    assert(!rRe.ok && /already under auction|not hold/.test(rRe.error ?? ''), `S7a: RE-AUCTION of an auction-locked license rejected (the Slice 1 T7 deferral, now complete) [${rRe.error}]`)
    // settle (no bids → no sale) frees the license; now it trades.
    await getAuctionState('p-1', 'A')
    assert((await license('C1')).under_auction === null, `S7b: after settlement the license is unlocked`)
    // need market open with a close time for a fresh createAuction; re-seed adds closes_in_ms
    await seed({
      closes_in_ms: 1_200_000,
      teams: [{ team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) }],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1 }],
    })
    const rOk = await createAuction('p-1', 'C', 1, 0)
    assert(rOk.ok, `S7c: an unlocked license can be auctioned again`)
  }

  // ══ S8 — PRIVACY: getAuctionState leaks nothing (the Slice 3 privacy-walk foundation) ══
  banner('S8 — privacy: no reserve, no bid amounts, no bid count; clearing price only to parties')
  {
    const RESERVE = 317, BID2 = 411, BID3 = 522 // distinctive values to grep for
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, escrowed: BID2, password: PW(2) },
        { team_number: 3, members: ['p-3'], cash: 10000, escrowed: BID3, password: PW(3) },
        { team_number: 4, members: ['p-4'], cash: 10000, password: PW(4) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: RESERVE, license_ids: ['C1'], ends_at_ms: 9_999_999_999_999, status: 'open' }],
      bids: [{ auction_id: 'A', team_number: 2, amount: BID2, at_ms: 100 }, { auction_id: 'A', team_number: 3, amount: BID3, at_ms: 200 }],
    })
    const hasNum = (obj, n) => JSON.stringify(obj).includes(String(n))
    // LIVE: a non-bidding team sees nothing sensitive.
    const live4 = await getAuctionState('p-4', 'A')
    assert(live4.ok && !hasNum(live4.result, RESERVE) && !hasNum(live4.result, BID2) && !hasNum(live4.result, BID3),
      `S8a-live: non-bidder sees NO reserve, NO bid amounts (grep clean)`)
    assert(!('bid_count' in live4.result) && !('bids' in live4.result), `S8a-live: no bid count / bid list field present`)
    // LIVE: a bidder sees ONLY their own bid, not the reserve, not the other bid.
    const live2 = await getAuctionState('p-2', 'A')
    assert(live2.result.your_bid === BID2 && !hasNum(live2.result, RESERVE) && !hasNum(live2.result, BID3),
      `S8b-live: bidder sees own bid (${BID2}) but NOT reserve, NOT the other bid (${BID3})`)
    // Now settle (both bids ≥ reserve; team 3 @522 wins).
    // give it a past end by re-seeding as ended, preserving bids + escrow.
    await seed({
      teams: [
        { team_number: 1, members: ['p-1'], cash: 1000, password: PW(1) },
        { team_number: 2, members: ['p-2'], cash: 10000, escrowed: BID2, password: PW(2) },
        { team_number: 3, members: ['p-3'], cash: 10000, escrowed: BID3, password: PW(3) },
        { team_number: 4, members: ['p-4'], cash: 10000, password: PW(4) },
      ],
      licenses: [{ id: 'C1', region: 'C', owner_team: 1, under_auction: 'A' }],
      auctions: [{ id: 'A', region: 'C', quantity: 1, seller_team: 1, reserve: RESERVE, license_ids: ['C1'], ends_at_ms: 1000 }],
      bids: [{ auction_id: 'A', team_number: 2, amount: BID2, at_ms: 100 }, { auction_id: 'A', team_number: 3, amount: BID3, at_ms: 200 }],
    })
    await getAuctionState('p-1', 'A') // seller touch settles it
    const aq = await auction('A')
    assert(aq.status === 'settled' && aq.winner_team === 3 && aq.clearing_price === BID3, `S8-settle: team 3 wins @ ${BID3}`)
    // LOSER (team 2): learns it lost, NOT the clearing price, NOT the reserve.
    const loser = await getAuctionState('p-2', 'A')
    assert(loser.result.you_won === false, `S8c: loser learns they LOST`)
    assert(!hasNum(loser.result, BID3) && !hasNum(loser.result, RESERVE),
      `S8c: loser does NOT learn the clearing price (${BID3}) or the reserve (${RESERVE}) [grep clean]`)
    // NON-PARTY (team 4): learns nothing but that it settled.
    const np = await getAuctionState('p-4', 'A')
    assert(!hasNum(np.result, BID3) && !hasNum(np.result, RESERVE) && !hasNum(np.result, BID2),
      `S8d: non-party sees NO clearing price, NO reserve, NO bids [grep clean]`)
    // WINNER (team 3) + SELLER (team 1): a party, learns the price.
    const winner = await getAuctionState('p-3', 'A')
    const seller = await getAuctionState('p-1', 'A')
    assert(winner.result.clearing_price === BID3 && winner.result.you_won === true, `S8e: WINNER learns what they paid (${BID3})`)
    assert(seller.result.clearing_price === BID3, `S8f: SELLER (a party) learns the sale price (${BID3})`)
    assert(!hasNum(np.result, RESERVE) && !hasNum(winner.result, RESERVE) && !hasNum(seller.result, RESERVE),
      `S8g: the RESERVE (${RESERVE}) leaks to NOBODY — not winner, not seller, not non-party`)
  }

  banner(`RESULT — ${PASS}/${PASS + FAIL} green${FAIL ? `  (${FAIL} FAILED)` : ''}`)
}

;(async () => {
  try { await main() }
  catch (err) { FAIL++; console.error('\n✗ FATAL:', err?.message ?? err) }
  finally {
    console.log(`\nDONE — ${PASS} passed, ${FAIL} failed`)
    tearDown()
    process.exit(FAIL ? 1 : 0)
  }
})()
