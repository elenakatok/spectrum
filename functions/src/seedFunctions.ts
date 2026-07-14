import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { regionOfLicenseId, portfolioValueFor, type SynergyRow } from './ledgerCore'

// Emulator-only: seed participants and RTDB presence for triggerMatching tests.
export const seedMatchTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown; participants?: unknown; clear?: unknown
  }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' })
    return
  }
  if (!Array.isArray(body.participants)) {
    res.status(400).json({ error: 'participants array required' })
    return
  }

  // Spectrum: single role `trader`. `present` (default true) controls RTDB presence, so a
  // seeded no-show (present:false) is attendance-set but held out of grouping. `clear`
  // (default true) wipes existing state; pass clear:false to APPEND fillers to a live run
  // (used by the Slice 0 grouping test — 14 present needed, but the UI drove only a few).
  type SeedP = { id: string; role: 'trader'; present?: boolean }
  const gameInstanceId = body.game_instance_id
  const participants = body.participants as SeedP[]
  const clear = body.clear !== false // default true

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  if (clear) {
    // Clear existing participants and groups for a clean test run.
    const [existingPs, existingGs] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
    ])
    if (existingPs.size > 0 || existingGs.size > 0) {
      const clearBatch = db.batch()
      for (const d of existingPs.docs) clearBatch.delete(d.ref)
      for (const d of existingGs.docs) clearBatch.delete(d.ref)
      await clearBatch.commit()
    }
    await rtdb.ref(`presence/${gameInstanceId}`).remove()
  }

  // Seed participant docs and RTDB presence.
  const seedBatch = db.batch()
  const presenceData: Record<string, unknown> = {}
  for (const p of participants) {
    seedBatch.set(instanceRef.collection('participants').doc(p.id), {
      participant_id: p.id,
      game_instance_id: gameInstanceId,
      role: p.role,
      prep_status: 'complete',
      attendance_confirmed_at: now,
      confirmed_ready_at: now,
    })
    if (p.present !== false) presenceData[p.id] = { online: true, last_seen: now.toMillis() }
  }
  await seedBatch.commit()
  // MERGE presence (update, not set) so appending fillers never wipes UI students' presence.
  if (Object.keys(presenceData).length > 0) {
    await rtdb.ref(`presence/${gameInstanceId}`).update(presenceData)
  }

  res.json({ ok: true, seeded: participants.length })
})

// Emulator-only: seed a matched group directly (bypass triggerMatching) for outcome tests.
// Spectrum group composition: single role `trader`, 4–7 participants per group.
export const seedGroupForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown
    group_id?: unknown
    lead_id?: unknown
    trader_participants?: unknown
  }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  if (typeof body.group_id !== 'string' || !body.group_id) {
    res.status(400).json({ error: 'group_id required' }); return
  }
  if (typeof body.lead_id !== 'string' || !body.lead_id) {
    res.status(400).json({ error: 'lead_id required' }); return
  }
  if (!Array.isArray(body.trader_participants)) {
    res.status(400).json({ error: 'trader_participants array required' }); return
  }

  const gameInstanceId = body.game_instance_id
  const groupId = body.group_id
  const leadId = body.lead_id
  const traderPids = body.trader_participants as string[]

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // Clear any existing state.
  const [existingPs, existingGs] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingPs.size > 0 || existingGs.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingPs.docs) clearBatch.delete(d.ref)
    for (const d of existingGs.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }

  // Write group doc with the single-role participant array.
  const groupRef = instanceRef.collection('groups').doc(groupId)
  await groupRef.set({
    group_id: groupId,
    game_instance_id: gameInstanceId,
    trader_participants: traderPids,
    lead_participant_id: leadId,
    outcome: null,
    status: 'matched',
    matched_at: now,
  })

  // Write participant docs.
  const batch = db.batch()
  for (const pid of traderPids) {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'trader',
      group_id: groupId,
      is_lead: pid === leadId,
      attendance_confirmed_at: now,
    })
  }
  await batch.commit()

  res.json({ ok: true, group_id: groupId, lead_id: leadId })
})

// ─────────────────────────────────────────────────────────────────────────────
// Emulator-only: seed a precise LEDGER state for the Slice 1 concurrency suite.
// Full control over teams (cash/escrow/holdings/password/synergy), the license board,
// and optional auctions + sealed bids. Flat schedule-1 synergy by default (value = 100
// per license) so portfolios are trivially checkable; pass explicit synergy to override.
// ─────────────────────────────────────────────────────────────────────────────
interface SeedTeam {
  team_number: number
  members?: string[]
  cash: number
  escrowed?: number
  password: string
  synergy?: SynergyRow[]
}
interface SeedLicense { id: string; region: string; region_index?: number; owner_team: number; under_auction?: string | null }
interface SeedAuction { id: string; region: string; quantity: number; seller_team: number; reserve: number; license_ids: string[]; ends_at_ms: number; status?: string }
interface SeedBid { auction_id: string; team_number: number; amount: number; at_ms: number; acted_by?: string }

export const seedLedgerTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') { res.status(404).json({ error: 'Not found' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: string
    market_status?: string
    closes_in_ms?: number             // market closes at (now + this); for cutoff tests
    auction_duration_minutes?: number // default 4
    teams?: SeedTeam[]
    licenses?: SeedLicense[]
    auctions?: SeedAuction[]
    bids?: SeedBid[]
  }
  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  const gid = body.game_instance_id
  const teams = body.teams ?? []
  const licenses = body.licenses ?? []
  const auctions = body.auctions ?? []
  const bids = body.bids ?? []

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gid)

  // Clear everything under the instance we manage (participants, groups incl. truth,
  // licenses, auctions incl. bids, transactions, market).
  const subcols = ['participants', 'groups', 'licenses', 'auctions', 'transactions', 'market']
  for (const c of subcols) {
    const snap = await instanceRef.collection(c).get()
    for (const d of snap.docs) {
      // delete known subcollections first (truth under groups, bids under auctions)
      for (const sub of ['truth', 'bids']) {
        const ss = await d.ref.collection(sub).get()
        const b = db.batch()
        ss.docs.forEach((x) => b.delete(x.ref))
        if (ss.size) await b.commit()
      }
    }
    const b = db.batch()
    snap.docs.forEach((d) => b.delete(d.ref))
    if (snap.size) await b.commit()
  }

  // Default flat synergy: schedule 1 (value = 100 per license) over every region present.
  const allRegions = [...new Set(licenses.map((l) => l.region))].sort()
  const flatSynergy: SynergyRow[] = allRegions.map((region) => ({
    region, schedule: 1, values: [100, 200, 300, 400, 500, 600, 700, 800],
  }))

  const licenseIdsOf = (team: number) => licenses.filter((l) => l.owner_team === team).map((l) => l.id).sort()

  const batch = db.batch()
  const now = Timestamp.now()

  for (const t of teams) {
    const groupId = `team-${t.team_number}`
    const members = t.members ?? [`p-${t.team_number}`]
    const held = licenseIdsOf(t.team_number)
    const synergy = t.synergy ?? flatSynergy
    batch.set(instanceRef.collection('groups').doc(groupId), {
      group_id: groupId, game_instance_id: gid, team_number: t.team_number,
      trader_participants: members, lead_participant_id: members[0] ?? null,
      outcome: null, status: 'matched', matched_at: now, license_ids: held,
    })
    batch.set(instanceRef.collection('groups').doc(groupId).collection('truth').doc('team'), {
      team_number: t.team_number, password: t.password, synergy,
      cash: t.cash, escrowed: t.escrowed ?? 0, license_ids: held,
      portfolio_value: portfolioValueFor(t.cash, held, synergy),
    })
    for (const pid of members) {
      batch.set(instanceRef.collection('participants').doc(pid), {
        participant_id: pid, game_instance_id: gid, role: 'trader',
        group_id: groupId, is_lead: pid === members[0], team_number: t.team_number,
        attendance_confirmed_at: now,
      })
    }
  }

  for (const l of licenses) {
    batch.set(instanceRef.collection('licenses').doc(l.id), {
      license_id: l.id, region: l.region,
      region_index: l.region_index ?? (l.region.charCodeAt(0) - 64),
      owner_team: l.owner_team, under_auction: l.under_auction ?? null,
    })
  }

  for (const a of auctions) {
    batch.set(instanceRef.collection('auctions').doc(a.id), {
      auction_id: a.id, region: a.region, quantity: a.quantity, seller_team: a.seller_team,
      reserve: a.reserve, license_ids: a.license_ids, status: a.status ?? 'open',
      ends_at: Timestamp.fromMillis(a.ends_at_ms), winner_team: null, clearing_price: null,
    })
  }
  for (const bid of bids) {
    batch.set(instanceRef.collection('auctions').doc(bid.auction_id).collection('bids').doc(`team-${bid.team_number}`), {
      team_number: bid.team_number, amount: bid.amount, at: bid.at_ms, acted_by: bid.acted_by ?? `p-${bid.team_number}`,
    })
  }

  const marketState: Record<string, unknown> = {
    status: body.market_status ?? 'open', num_teams: teams.length,
    num_regions: allRegions.length, starting_cash: 1000,
    auction_duration_minutes: body.auction_duration_minutes ?? 4,
  }
  if (body.closes_in_ms != null) {
    marketState.closes_at = Timestamp.fromMillis(now.toMillis() + body.closes_in_ms)
    marketState.opened_at = now
  }
  batch.set(instanceRef.collection('market').doc('state'), marketState)

  await batch.commit()
  void regionOfLicenseId
  res.json({ ok: true, teams: teams.length, licenses: licenses.length, auctions: auctions.length, bids: bids.length })
})
