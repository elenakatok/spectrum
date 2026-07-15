// Spectrum instructor read-paths — Slice 4. TWO read-only callables, ZERO economic logic.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §12 (five instructor views) + §13.1 (the
// transaction graph is instructor-only BY CONSTRUCTION — there is no student path to it in
// the DOM, the API, or RTDB) + §13.2 (efficient-market benchmark, closed form).
//
// The instructor dashboard's five views draw on:
//   • View 1 Team Performance  — getLeaderboard (below): every team's cash / license value /
//                                 portfolio, plus the room aggregates + efficient benchmark.
//   • View 2 Ownership         — the PUBLIC licenses/groups collections (no callable).
//   • View 3 Transaction Graph — getTransactionGraph (below): every settled deal/auction as a
//                                 price-per-license point, swaps as price-less strip points.
//   • View 4 Teams             — the shared getRoster + the public groups (client-side join).
//   • View 5 Quiz Results      — a classroom link (no callable).
//
// Both callables are INSTRUCTOR-authenticated (extractInstructorGameId) and mint NO
// transactions, move NO money, and touch NO ledger code — pure reads, in the mold of the
// Slice 3 student reads. getTransactionGraph is the one read that exposes prices across ALL
// teams; that it is instructor-only is the privacy boundary the walk asserts end-to-end.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import type { GameDefinition } from '@mygames/game-server'
import { truthRef, isEmu, authHeaderOf, type Ref } from './ledger'
import { computeRegionGains, teamHoldingRows, type HoldingsMap } from './marketReportCore'

const toMillis = (v: unknown): number | null =>
  v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null

// ─────────────────────────────────────────────────────────────────────────────
// 1. getLeaderboard — every team's live financials, ranked, for View 1. Reads each team's
//    rules-denied truth doc (cash + portfolio_value); license_value is DERIVED (portfolio −
//    cash), NOT the stamped `license_value` field, which goes stale after the first trade
//    (the ledger keeps portfolio_value fresh but never re-writes license_value). Team NAMES
//    are deliberately NOT folded in here — View 4 sources them from the shared getRoster.
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetLeaderboard(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const instanceRef: Ref = admin.firestore().collection('game_instances').doc(gameInstanceId)

    const [groupsSnap, stateSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('market').doc('state').get(),
    ])
    const state = stateSnap.data() ?? {}

    const grouped = groupsSnap.docs.filter((g) => g.data()['team_number'] != null)
    const truths = await Promise.all(
      grouped.map((g) => truthRef(instanceRef, g.id).get()),
    )
    const teams = grouped
      .map((g, i) => {
        const t = truths[i].data() ?? {}
        const cash = Number(t['cash'] ?? 0)
        const portfolio = Number(t['portfolio_value'] ?? 0)
        return {
          team_number: g.data()['team_number'] as number,
          cash,
          license_value: portfolio - cash,
          portfolio_value: portfolio,
        }
      })
      .sort((a, b) => b.portfolio_value - a.portfolio_value)

    return {
      ok: true as const,
      teams,
      value_after_trade: teams.reduce((s, t) => s + t.portfolio_value, 0),
      total_initial_value: Number(state['total_initial_value'] ?? 0),
      efficient_market_value: Number(state['efficient_market_value'] ?? 0),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. getTransactionGraph — every settled transaction, as a graph point, for View 3. Deals and
//    auctions carry a price → price_per_license (price/quantity); swaps carry no price (null)
//    and are drawn on a separate strip. opened_at anchors the X axis (elapsed minutes). This
//    is the ONE read that returns prices across all teams — INSTRUCTOR ONLY, by construction.
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetTransactionGraph(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const instanceRef: Ref = admin.firestore().collection('game_instances').doc(gameInstanceId)

    const [txSnap, stateSnap] = await Promise.all([
      instanceRef.collection('transactions').get(),
      instanceRef.collection('market').doc('state').get(),
    ])
    if (!stateSnap.exists) throw new HttpsError('failed-precondition', 'The market has not been grouped yet.')

    const points = txSnap.docs
      .map((d) => {
        const x = d.data()
        const type = x['type'] as string
        const isSwap = type === 'swap'
        const price = isSwap ? null : ((x['price'] as number | null | undefined) ?? null)
        const quantity = isSwap ? null : Number(x['quantity'] ?? 0)
        const region = isSwap ? ((x['region_x'] as string | undefined) ?? null) : ((x['region'] as string | undefined) ?? null)
        return {
          type,
          region,
          quantity,
          price,
          price_per_license: price != null && quantity ? price / quantity : null,
          at_ms: toMillis(x['at']),
        }
      })
      .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0))

    return {
      ok: true as const,
      opened_at: toMillis(stateSnap.data()?.['opened_at']),
      points,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. getMarketReport (Slice 6) — the debrief join. ONE instructor-only callable that
//    serves BOTH Report 3 (per-region gains-from-trade) AND Report 4 (per-team detail),
//    keeping the synergy + ownership + ledger join in a single instructor-authed place.
//
//    INSTRUCTOR ONLY, BY CONSTRUCTION — like getTransactionGraph, this returns synergy-
//    derived valuations and price/actor data across ALL teams. There is NO student path to
//    it (DOM/API/RTDB); a student caller is rejected outright by extractInstructorGameId.
//    Synergy is NEVER returned to any student path — the privacy walk asserts this leg.
//
//    Synergy is computed PURELY from (team, region, M) via the exact functions
//    (assignedSchedule/valueOfHolding) that GENERATED each team's stored truth.synergy, so
//    realized/efficient here are identical to the truth docs by construction — no denied
//    reads needed. Ownership is read from the `licenses` collection (owner_team is the ONE
//    ownership truth, invariant 1). The efficient value per region is the value(8) argmax
//    (=1550, the schedule-4 team) — the SAME benchmark getLeaderboard's aggregate uses.
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetMarketReport(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const instanceRef: Ref = admin.firestore().collection('game_instances').doc(gameInstanceId)
    const rtdb = admin.database()

    const [stateSnap, groupsSnap, licensesSnap, txSnap, participantsSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('market').doc('state').get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('licenses').get(),
      instanceRef.collection('transactions').get(),
      instanceRef.collection('participants').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])
    if (!stateSnap.exists) throw new HttpsError('failed-precondition', 'The market has not been grouped yet.')
    const state = stateSnap.data() ?? {}
    const N = Number(state['num_teams'] ?? 0)
    const M = Number(state['num_regions'] ?? (N > 0 ? N / 2 : 0))
    if (N < 1 || M < 1) throw new HttpsError('failed-precondition', 'The market has not been grouped yet.')

    // ── Names: RTDB attendance display_name wins, then participants doc, then a short id. ──
    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>
    const pById = new Map<string, Record<string, unknown>>()
    for (const p of participantsSnap.docs) pById.set(p.id, p.data() as Record<string, unknown>)
    const nameOf = (pid: string): string => {
      const d = pById.get(pid) ?? {}
      const rtdbName = attending[pid]?.display_name?.trim()
      const fsName = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      return rtdbName || fsName || `${pid.slice(0, 8)}…`
    }

    // ── Ownership tally: current holdings[team][regionIndex] = count, from the licenses truth. ──
    const regionIndexOf = (letter: string): number => letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1
    const holdings: HoldingsMap = new Map<number, Map<number, number>>() // team -> (regionIndex -> count)
    for (const d of licensesSnap.docs) {
      const owner = Number(d.data()['owner_team'] ?? 0)
      const ri = regionIndexOf(String(d.data()['region'] ?? ''))
      if (owner < 1 || ri < 1) continue
      const byRegion = holdings.get(owner) ?? new Map<number, number>()
      byRegion.set(ri, (byRegion.get(ri) ?? 0) + 1)
      holdings.set(owner, byRegion)
    }

    // ── Report 3: per-region gains-from-trade (PURE core — see marketReportCore.ts). Efficient =
    //    value(8) argmax; realized = Σ current holders' OWN value(count); gap = efficient − realized. ──
    const regions = computeRegionGains(holdings, N, M)

    // ── Attributed transaction ledger (Report 4). Full team identity + actor names — the data
    //    getTransactionGraph deliberately strips. Instructor-only, like the rest of this call. ──
    const actionCount = new Map<string, number>() // participant_id -> # deals/swaps they initiated
    const transactions = txSnap.docs
      .map((d) => {
        const x = d.data()
        const type = x['type'] as string
        const actedBy = (x['acted_by'] as string | null) ?? null
        if (actedBy) actionCount.set(actedBy, (actionCount.get(actedBy) ?? 0) + 1)
        const isSwap = type === 'swap'
        const price = isSwap ? null : ((x['price'] as number | null | undefined) ?? null)
        const quantity = isSwap ? null : (x['quantity'] != null ? Number(x['quantity']) : null)
        return {
          transaction_id: (x['transaction_id'] as string) ?? d.id,
          type,
          from_team: (x['from_team'] as number | null) ?? null,
          to_team: (x['to_team'] as number | null) ?? null,
          region: isSwap ? null : ((x['region'] as string | undefined) ?? null),
          quantity,
          price,
          price_per_license: price != null && quantity ? price / quantity : null,
          region_x: isSwap ? ((x['region_x'] as string | undefined) ?? null) : null,
          quantity_x: isSwap ? ((x['quantity_x'] as number | undefined) ?? null) : null,
          region_y: isSwap ? ((x['region_y'] as string | undefined) ?? null) : null,
          quantity_y: isSwap ? ((x['quantity_y'] as number | undefined) ?? null) : null,
          acted_by: actedBy,
          acted_by_name: actedBy ? nameOf(actedBy) : null,
          at_ms: toMillis(x['at']),
        }
      })
      .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0))

    // ── Per-team detail (Report 4): current holdings-with-value + members + their activity. ──
    const membersByTeam = new Map<number, string[]>() // team_number -> participant_ids
    for (const p of participantsSnap.docs) {
      const t = Number((p.data() as Record<string, unknown>)['team_number'] ?? 0)
      if (t < 1) continue
      const arr = membersByTeam.get(t) ?? []
      arr.push(p.id)
      membersByTeam.set(t, arr)
    }
    const teams = groupsSnap.docs
      .filter((g) => g.data()['team_number'] != null)
      .map((g) => {
        const team_number = g.data()['team_number'] as number
        const teamHoldings = teamHoldingRows(holdings, team_number, M)
        const members = (membersByTeam.get(team_number) ?? [])
          .map((pid) => ({ participant_id: pid, display_name: nameOf(pid), action_count: actionCount.get(pid) ?? 0 }))
          .sort((a, b) => a.display_name.localeCompare(b.display_name))
        return { team_number, holdings: teamHoldings, members }
      })
      .sort((a, b) => a.team_number - b.team_number)

    return {
      ok: true as const,
      num_teams: N,
      num_regions: M,
      opened_at: toMillis(state['opened_at']),
      regions,
      teams,
      transactions,
    }
  })
}
