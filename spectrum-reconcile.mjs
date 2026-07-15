/**
 * Spectrum — LEDGER RECONCILIATION (v3 §15, the Slice-7 named assertion). REUSABLE.
 *
 * The strongest correctness proof there is: replay the ENTIRE transactions/ log from the
 * generated endowments and reproduce the live final state EXACTLY — every license's owner,
 * every team's cash, every portfolio value — license-for-license and dollar-for-dollar.
 *
 * If replay diverges from live state anywhere, a mutation is happening OUTSIDE the transaction
 * log (a lost write, hidden state, drift) — which must be found and fixed before humans play.
 *
 * BASELINE = the pure generator (assignLicenses(N) + starting cash), NOT a snapshot — so a pass
 * also proves grouping produced the correct opening state. Replay is order-insensitive for the
 * FINAL state (license moves are disjoint at commit time; cash moves are commutative and the log
 * holds only COMMITTED transactions) — we sort by `at` anyway for clarity.
 *
 * Runs against the EMULATOR (set FIRESTORE_EMULATOR_HOST, e.g. from the shakeout) or PROD (ADC).
 * Reusable as a permanent check — re-run it after the pre-October human dry run to prove the
 * ledger stayed consistent under real play:
 *
 *   GID=<instance> node spectrum-reconcile.mjs                    # prod (ADC)
 *   FIRESTORE_EMULATOR_HOST=localhost:8082 GID=<id> node spectrum-reconcile.mjs   # emulator
 */
import admin from './functions/node_modules/firebase-admin/lib/index.js'
import { assignLicenses, valueOfHolding, assignedSchedule } from './functions/lib/synergy.js'

const DEFAULT_PROJECT = 'spectrum-mygames-live'

let _app = null
function appFor(projectId) {
  if (_app) return _app
  const emu = !!process.env.FIRESTORE_EMULATOR_HOST
  _app = admin.initializeApp(
    emu ? { projectId } : { credential: admin.credential.applicationDefault(), projectId },
    `reconcile-${projectId}-${emu ? 'emu' : 'prod'}`,
  )
  return _app
}

const regionIndexOf = (licenseId) => licenseId.charCodeAt(0) - 'A'.charCodeAt(0) + 1

/**
 * Replay the transaction log from the endowments and compare to live state.
 * Returns { pass, fail, checks: [...], ok }. Does NOT exit — callers decide.
 */
export async function reconcile({ projectId = DEFAULT_PROJECT, gid, log = console.log } = {}) {
  if (!gid) throw new Error('reconcile: gid is required')
  const db = admin.firestore(appFor(projectId))
  const inst = db.collection('game_instances').doc(gid)

  let pass = 0, fail = 0
  const checks = []
  const ok = (cond, name) => { if (cond) { pass++; log(`  ✓ ${name}`) } else { fail++; log(`  ✗ FAILED: ${name}`) }; checks.push({ name, cond: !!cond }); return cond }

  const state = (await inst.collection('market').doc('state').get()).data() ?? {}
  const N = Number(state.num_teams)
  const M = Number(state.num_regions ?? (N ? N / 2 : 0))
  const startingCash = Number(state.starting_cash ?? (N ? state.total_initial_value / N - 400 : 0))
  if (!(N >= 2) || !(M >= 1)) { ok(false, `market grouped (num_teams=${state.num_teams})`); return { pass, fail, checks, ok: false } }
  log(`  reconciling instance ${gid}: N=${N}, M=${M}, starting cash $${startingCash}`)

  // ── BASELINE — the pure generator: every license → its endowment owner; every team → cash. ──
  const owner = new Map()   // licenseId -> team_number
  for (const l of assignLicenses(N)) owner.set(l.licenseId, l.ownerTeam)
  const cash = new Map()    // team_number -> cash
  for (let g = 1; g <= N; g++) cash.set(g, startingCash)

  // ── REPLAY — apply every transaction in commit order. ──
  const txs = (await inst.collection('transactions').get()).docs
    .map((d) => d.data())
    .sort((a, b) => (a.at?.toMillis?.() ?? 0) - (b.at?.toMillis?.() ?? 0))
  let deals = 0, swaps = 0, auctions = 0
  for (const t of txs) {
    if (t.type === 'deal' || t.type === 'auction') {
      for (const id of (t.license_ids ?? [])) owner.set(id, t.to_team)
      const price = Number(t.price ?? 0)
      cash.set(t.to_team, cash.get(t.to_team) - price)      // buyer/winner pays
      cash.set(t.from_team, cash.get(t.from_team) + price)  // seller receives
      if (t.type === 'deal') deals++; else auctions++
    } else if (t.type === 'swap') {
      for (const id of (t.license_ids_x ?? [])) owner.set(id, t.to_team)     // initiator → partner
      for (const id of (t.license_ids_y ?? [])) owner.set(id, t.from_team)   // partner → initiator
      swaps++
    }
  }
  log(`  replayed ${txs.length} transactions (${deals} deals, ${auctions} auctions, ${swaps} swaps)`)

  // Replayed holdings + portfolio per team.
  const heldByTeam = new Map()
  for (const [lid, team] of owner) { const a = heldByTeam.get(team) ?? []; a.push(lid); heldByTeam.set(team, a) }
  const replayedPortfolio = (team) => {
    const byRi = new Map()
    for (const lid of (heldByTeam.get(team) ?? [])) { const ri = regionIndexOf(lid); byRi.set(ri, (byRi.get(ri) ?? 0) + 1) }
    let v = cash.get(team)
    for (const [ri, c] of byRi) v += valueOfHolding(assignedSchedule(team, ri, M), c)
    return v
  }

  // ── LIVE — the current authoritative state. ──
  const liveLic = (await inst.collection('licenses').get()).docs
  const liveOwner = new Map(liveLic.map((d) => [d.id, Number(d.data().owner_team)]))

  // (1) One owner per license, license-for-license identical to the replay.
  let licMismatch = []
  for (const [id, t] of owner) { if (liveOwner.get(id) !== t) licMismatch.push(`${id}: replay T${t} vs live T${liveOwner.get(id)}`) }
  ok(liveOwner.size === owner.size && licMismatch.length === 0,
    `LICENSES: all ${owner.size} licenses match live owner exactly, license-for-license${licMismatch.length ? ` (${licMismatch.slice(0, 5).join('; ')})` : ''}`)

  // (2) Cash + (3) portfolio + (4) holdings set, per team, dollar-for-dollar against truth docs.
  const groups = (await inst.collection('groups').get()).docs.filter((g) => g.data().team_number != null)
  let cashMismatch = [], portMismatch = [], holdMismatch = []
  let replaySum = 0
  for (const g of groups) {
    const team = Number(g.data().team_number)
    const truth = (await g.ref.collection('truth').doc('team').get()).data() ?? {}
    const liveCash = Number(truth.cash ?? 0)
    const livePort = Number(truth.portfolio_value ?? 0)
    if (cash.get(team) !== liveCash) cashMismatch.push(`T${team}: replay $${cash.get(team)} vs live $${liveCash}`)
    const rp = replayedPortfolio(team)
    if (rp !== livePort) portMismatch.push(`T${team}: replay $${rp} vs live $${livePort}`)
    const liveHeld = new Set((truth.license_ids ?? []))
    const replayHeld = new Set(heldByTeam.get(team) ?? [])
    if (liveHeld.size !== replayHeld.size || [...replayHeld].some((x) => !liveHeld.has(x))) holdMismatch.push(`T${team}`)
    replaySum += cash.get(team)
  }
  ok(cashMismatch.length === 0, `CASH: every team's cash matches live truth, dollar-for-dollar${cashMismatch.length ? ` (${cashMismatch.slice(0, 5).join('; ')})` : ''}`)
  ok(portMismatch.length === 0, `PORTFOLIO: every team's portfolio value matches live truth${portMismatch.length ? ` (${portMismatch.slice(0, 5).join('; ')})` : ''}`)
  ok(holdMismatch.length === 0, `HOLDINGS: every team's truth.license_ids set matches the replay${holdMismatch.length ? ` (teams ${holdMismatch.join(',')})` : ''}`)
  // Cash conservation as a closing sanity — the replayed sum must equal N × starting cash.
  ok(replaySum === N * startingCash, `CASH CONSERVATION: Σ replayed cash $${replaySum} === N×starting $${N * startingCash}`)

  return { pass, fail, checks, ok: fail === 0 }
}

// ── Standalone entry ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith('spectrum-reconcile.mjs')
if (isMain) {
  const gid = process.env.GID
  const projectId = process.env.PROJECT || DEFAULT_PROJECT
  if (!gid) { console.error('Set GID=<instance id>. For emulator, also set FIRESTORE_EMULATOR_HOST.'); process.exit(2) }
  console.log(`\n=== Ledger reconciliation → ${process.env.FIRESTORE_EMULATOR_HOST ? 'EMULATOR' : 'PROD'} · instance ${gid} ===\n`)
  reconcile({ projectId, gid })
    .then((r) => { console.log(`\n=== reconciliation ${r.ok ? 'PASSED' : 'FAILED'} — ${r.pass} passed, ${r.fail} failed ===`); process.exit(r.ok ? 0 : 1) })
    .catch((e) => { console.error('💥 reconcile crashed:', e); process.exit(2) })
}
