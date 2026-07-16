// Spectrum instructor grouping — Slice 0.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §9.1 plus the Slice 0 locked
// addenda: grouping is TWO instructor actions / TWO transactions, NOT one atomic
// press (v3 §9.1's single-press wording is superseded):
//
//   Button 1 — groupParticipants: partition present students into N teams, assign
//     positional passwords, derive M = N/2, generate synergy maps + endowments,
//     write rules-denied truth + public license ownership. Market status -> 'grouped'.
//     The CLOCK DOES NOT START. Students land in their teams and read.
//   Button 2 — startMarket: status 'grouped' -> 'open', set opened_at / closes_at.
//     The clock starts. (Trading itself is rejected unless status === 'open' — that
//     server-side gate arrives with the ledger in Slice 1.)
//
// This REPLACES the shared rolling matcher (makeTriggerMatching) for Spectrum. The
// shared matcher tiles random {trader:4} groups and cannot take an instructor-set N
// or make variable-size teams. We bypass it and write the SAME group doc shape the
// rest of the pipeline (getRoster, scoreAndRecord, finalize, reports) expects.
//
// PLATFORM MAPPING (surfaced as an interpretation): v3 speaks of a "market" with
// "teams"; the platform speaks of a "game_instance" with "groups". We map
// team -> group and market -> the instance, exactly as eBay maps an auction -> a
// group. A Spectrum team IS a platform group doc (trader_participants:[...]); its
// private synergy + password live in groups/{gid}/truth/team (rules-denied), with a
// server-stamped copy on each member's own participant doc for the student view.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import type { GameDefinition } from '@mygames/game-server'
import {
  generateTeams,
  assignLicenses,
  efficientMarketValue,
  validateNumTeams,
  regionLetter,
  DEFAULT_STARTING_CASH,
  DEFAULT_MARKET_DURATION_MINUTES,
  DEFAULT_AUCTION_DURATION_MINUTES,
} from './synergy'

const TRADER_ROLE = 'trader'
const TRUTH_DOC = 'team'

interface InstanceConfig {
  startingCash: number
  marketDurationMinutes: number
  auctionDurationMinutes: number
}

/** Read instance config/main, falling back to declared defaults. */
async function readInstanceConfig(
  instanceRef: admin.firestore.DocumentReference,
): Promise<InstanceConfig> {
  const snap = await instanceRef.collection('config').doc('main').get()
  const cfg = (snap.data() ?? {}) as Record<string, unknown>
  const num = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt
  return {
    startingCash: num(cfg['starting_cash'], DEFAULT_STARTING_CASH),
    marketDurationMinutes: num(cfg['market_duration_minutes'], DEFAULT_MARKET_DURATION_MINUTES),
    auctionDurationMinutes: num(cfg['auction_duration_minutes'], DEFAULT_AUCTION_DURATION_MINUTES),
  }
}

/**
 * Button 1 — partition present students into N teams and generate everything.
 * Idempotent: if groups already exist, returns the existing summary unchanged.
 *
 * Call data: { num_teams } (+ Bearer instructor auth, or emulator { _dev }).
 * Returns: { ok, num_teams, num_regions, teams_created, efficient_market_value, alreadyGrouped? }
 */
export function makeGroupParticipants(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined
    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const numTeams = data['num_teams']
    if (typeof numTeams !== 'number') {
      throw new HttpsError('invalid-argument', 'num_teams (number) is required')
    }
    try {
      validateNumTeams(numTeams)
    } catch (err) {
      throw new HttpsError('invalid-argument', err instanceof Error ? err.message : 'invalid num_teams')
    }
    const N = numTeams
    const M = N / 2

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      // Idempotency: if grouping already ran, return existing summary.
      const existing = await instanceRef.collection('groups').limit(1).get()
      if (!existing.empty) {
        const all = await instanceRef.collection('groups').get()
        const marketSnap = await instanceRef.collection('market').doc('state').get()
        const ms = (marketSnap.data() ?? {}) as Record<string, unknown>
        return {
          ok: true as const,
          alreadyGrouped: true,
          num_teams: (ms['num_teams'] as number) ?? all.size,
          num_regions: (ms['num_regions'] as number) ?? (all.size / 2),
          teams_created: all.size,
          efficient_market_value: (ms['efficient_market_value'] as number) ?? null,
        }
      }

      // Eligible: attended + trader + present in RTDB (same predicate as the shared matcher).
      const [presenceSnap, participantsSnap] = await Promise.all([
        admin.database().ref(`presence/${gameInstanceId}`).once('value'),
        instanceRef.collection('participants').get(),
      ])
      const present = new Set<string>(Object.keys((presenceSnap.val() ?? {}) as object))
      const eligible = participantsSnap.docs
        .filter((d) => {
          const v = d.data()
          return v['attendance_confirmed_at'] != null && v['role'] === TRADER_ROLE && present.has(d.id)
        })
        .map((d) => d.id)
        .sort() // deterministic partition

      if (eligible.length < N) {
        throw new HttpsError(
          'failed-precondition',
          `Need at least ${N} present students to form ${N} teams (have ${eligible.length}).`,
        )
      }

      const cfg = await readInstanceConfig(instanceRef)
      const teams = generateTeams(N) // passwords, synergy, endowment regions
      const licenses = assignLicenses(N) // license -> owner team (public ownership truth)

      // Round-robin members into teams (team g = 1..N).
      const membersByTeam: string[][] = Array.from({ length: N }, () => [])
      eligible.forEach((pid, i) => membersByTeam[i % N].push(pid))

      const batch = db.batch()

      // Per team: group doc (public), truth doc (rules-denied), participant stamps.
      for (const team of teams) {
        const g = team.teamNumber
        const members = membersByTeam[g - 1]
        const lead = members[0] ?? null
        // group_id sorts in TEAM ORDER (team-01 … team-NN, N ≤ 26): the shared roster numbers
        // groups by group_id sort order, so this makes its "Team #" column equal team_number
        // (a random UUID made it a meaningless permutation). Opaque doc id everywhere else.
        const groupId = `team-${String(g).padStart(2, '0')}`
        const licenseIds = licenses.filter((l) => l.ownerTeam === g).map((l) => l.licenseId)
        const endowmentRegionLetters = team.endowmentRegions.map(regionLetter)

        // Public group doc — team identity + PUBLIC license holdings (endowments are public).
        // No cash, no password, no synergy here (those are private).
        batch.set(instanceRef.collection('groups').doc(groupId), {
          group_id: groupId,
          game_instance_id: gameInstanceId,
          lead_participant_id: lead,
          trader_participants: members,
          outcome: null,
          status: 'matched',
          matched_at: FieldValue.serverTimestamp(),
          team_number: g,
          endowment_regions: endowmentRegionLetters,
          license_ids: licenseIds,
        })

        // Private truth — server-authoritative team ledger seed (Slice 1 mutates cash/holdings here).
        batch.set(instanceRef.collection('groups').doc(groupId).collection('truth').doc(TRUTH_DOC), {
          team_number: g,
          password: team.password,
          synergy: team.synergy,
          endowment_regions: endowmentRegionLetters,
          license_ids: licenseIds,
          cash: cfg.startingCash,
          license_value: 400,
          portfolio_value: 400 + cfg.startingCash,
          assigned_at: FieldValue.serverTimestamp(),
        })

        // Stamp each member's own participant doc (client reads own doc only — no cross-team leak).
        for (const pid of members) {
          batch.update(instanceRef.collection('participants').doc(pid), {
            group_id: groupId,
            is_lead: pid === lead,
            team_number: g,
            team_password: team.password,
            team_synergy: team.synergy,
            team_endowment_regions: endowmentRegionLetters,
            team_license_ids: licenseIds,
            team_cash: cfg.startingCash,
            team_license_value: 400,
            team_portfolio_value: 400 + cfg.startingCash,
          })
        }
      }

      // Public license ownership board (the "one owner" truth; Slice 1 ledger mutates this).
      for (const lic of licenses) {
        batch.set(instanceRef.collection('licenses').doc(lic.licenseId), {
          license_id: lic.licenseId,
          region_index: lic.regionIndex,
          region: lic.region,
          owner_team: lic.ownerTeam,
        })
      }

      // Market lifecycle doc: grouped, clock NOT started.
      batch.set(instanceRef.collection('market').doc('state'), {
        status: 'grouped',
        num_teams: N,
        num_regions: M,
        starting_cash: cfg.startingCash,
        market_duration_minutes: cfg.marketDurationMinutes,
        auction_duration_minutes: cfg.auctionDurationMinutes,
        efficient_market_value: efficientMarketValue(N, cfg.startingCash),
        total_initial_value: N * (400 + cfg.startingCash),
        grouped_at: FieldValue.serverTimestamp(),
        opened_at: null,
        closes_at: null,
      })

      await batch.commit()
      return {
        ok: true as const,
        num_teams: N,
        num_regions: M,
        teams_created: N,
        efficient_market_value: efficientMarketValue(N, cfg.startingCash),
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[groupParticipants] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

/**
 * Button 2 — open the market. Requires status 'grouped'. Sets opened_at / closes_at.
 * Idempotent: if already 'open', returns { alreadyStarted: true }.
 */
export function makeStartMarket(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined
    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      const stateRef = instanceRef.collection('market').doc('state')

      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(stateRef)
        if (!snap.exists) {
          throw new HttpsError('failed-precondition', 'Group participants before starting the market.')
        }
        const state = snap.data() as Record<string, unknown>
        const status = state['status'] as string

        if (status === 'open') {
          return {
            ok: true as const,
            alreadyStarted: true,
            opened_at: (state['opened_at'] as Timestamp | null)?.toMillis?.() ?? null,
            closes_at: (state['closes_at'] as Timestamp | null)?.toMillis?.() ?? null,
          }
        }
        if (status !== 'grouped') {
          throw new HttpsError('failed-precondition', `Market cannot be started from status '${status}'.`)
        }

        const durationMin = (state['market_duration_minutes'] as number) ?? DEFAULT_MARKET_DURATION_MINUTES
        const now = Timestamp.now()
        const closes = Timestamp.fromMillis(now.toMillis() + durationMin * 60_000)

        tx.update(stateRef, { status: 'open', opened_at: now, closes_at: closes })
        return {
          ok: true as const,
          alreadyStarted: false,
          opened_at: now.toMillis(),
          closes_at: closes.toMillis(),
        }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[startMarket] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

/**
 * "End market now" — instructor-only MANUAL hard close (dry-run item 6). Does EXACTLY what the
 * clock does at closes_at, by REUSING the one server-authoritative trigger the hard close already
 * keys off: it pulls closes_at back to now. That instant, requireMarketOpen (ledger.ts) rejects
 * every in-flight trade — identical to the clock reaching the deadline; there is NO parallel close
 * path. We ALSO flip status → 'closed' in the same write, which is precisely what getMarketState's
 * resolve-on-read flip does one poll later — doing it atomically just lets the projector + students
 * see "closed" without waiting for the next poll. In-flight actions are handled identically to a
 * clock close: deals/swaps past closes_at are rejected by requireMarketOpen, and any running auction
 * keeps its own ends_at lifecycle (a clock close leaves running auctions alone too). Requires an
 * open market; idempotent — a second call, or one after the clock already closed it, is a no-op.
 */
export function makeEndMarket(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined
    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const stateRef = db.collection('game_instances').doc(gameInstanceId).collection('market').doc('state')

      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(stateRef)
        if (!snap.exists) {
          throw new HttpsError('failed-precondition', 'The market has not been set up.')
        }
        const state = snap.data() as Record<string, unknown>
        const status = state['status'] as string

        if (status === 'closed') {
          return {
            ok: true as const,
            alreadyClosed: true,
            closes_at: (state['closes_at'] as Timestamp | null)?.toMillis?.() ?? null,
          }
        }
        if (status !== 'open') {
          throw new HttpsError('failed-precondition', `The market cannot be ended from status '${status}'.`)
        }

        // closes_at = now is the SAME trigger the clock reaches; the status flip mirrors
        // getMarketState's resolve-on-read. Ledger freeze + close happen through the existing path.
        const now = Timestamp.now()
        tx.update(stateRef, { status: 'closed', closes_at: now })
        return { ok: true as const, alreadyClosed: false, closes_at: now.toMillis() }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[endMarket] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

/**
 * Read-only market state for the instructor dashboard poll (drives button enablement).
 * Returns { ok, status: 'setup' } when grouping has not run.
 */
export function makeGetMarketState(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined
    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const db = admin.firestore()
    const stateRef = db.collection('game_instances').doc(gameInstanceId).collection('market').doc('state')
    const snap = await stateRef.get()
    if (!snap.exists) {
      return { ok: true as const, status: 'setup' as const }
    }
    const s = snap.data() as Record<string, unknown>
    // Resolve-on-read HARD CLOSE (v3 §9.2): once past closes_at, flip 'open' → 'closed' so the
    // dashboard + students' onSnapshot show the closed market. This is cosmetic — the ledger's
    // requireMarketOpen already rejects trades past closes_at regardless of this flip. Idempotent
    // (only flips while still 'open'); the instructor poll triggers it within a tick of the deadline.
    let status = s['status'] as string
    const closesAtMs = (s['closes_at'] as Timestamp | null)?.toMillis?.() ?? null
    if (status === 'open' && closesAtMs != null && Timestamp.now().toMillis() >= closesAtMs) {
      await stateRef.update({ status: 'closed' })
      status = 'closed'
    }
    return {
      ok: true as const,
      status,
      num_teams: (s['num_teams'] as number) ?? null,
      num_regions: (s['num_regions'] as number) ?? null,
      efficient_market_value: (s['efficient_market_value'] as number) ?? null,
      total_initial_value: (s['total_initial_value'] as number) ?? null,
      opened_at: (s['opened_at'] as Timestamp | null)?.toMillis?.() ?? null,
      closes_at: (s['closes_at'] as Timestamp | null)?.toMillis?.() ?? null,
    }
  })
}
