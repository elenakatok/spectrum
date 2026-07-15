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
