// Spectrum student read-paths — Slice 3. THREE read-only callables, ZERO economic logic.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §11 (five tabs) + the Slice 3 prompt.
//
// Slices 0–2 wrote all the game state but left three student-facing reads with no path:
//   • live cash / available (cash−escrowed) / portfolio  — lives in the rules-denied truth doc;
//   • own transaction history                            — transactions/ is rules-denied;
//   • the team→names roster                              — group doc has member IDs, not names.
// These are the reads the five tabs need. Each is student-authenticated (extractStudentOnCallIds)
// and returns ONLY the caller's own team-private data + the (already-public) names roster.
// They mint NO transactions, move NO money, touch NO ledger code — pure reads, in the
// paranoid-visibility mold of getAuctionState (Slice 2).

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '@mygames/game-server'
import type { GameDefinition } from '@mygames/game-server'
import { truthRef, isEmu, authHeaderOf, type Ref } from './ledger'

const toMillis = (v: unknown): number | null =>
  v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null

async function callerTeam(instanceRef: Ref, participantId: string): Promise<{
  groupId: string; teamNumber: number
}> {
  const part = (await instanceRef.collection('participants').doc(participantId).get()).data()
  const groupId = part?.['group_id'] as string | undefined
  const teamNumber = part?.['team_number'] as number | undefined
  if (!groupId || teamNumber == null) throw new HttpsError('failed-precondition', 'You are not on a team.')
  return { groupId, teamNumber }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. getTeamState — the caller's OWN live team ledger: cash / escrowed / available /
//    holdings / portfolio value. Reads the rules-denied truth doc for the caller's team
//    only; NEVER another team's, NEVER the password or synergy (the participant doc already
//    serves those to the own team; least-data here).
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetTeamState(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
    const { groupId, teamNumber } = await callerTeam(instanceRef, participantId)

    const t = (await truthRef(instanceRef, groupId).get()).data()
    if (!t) throw new HttpsError('not-found', 'Team ledger not found.')
    const cash = Number(t['cash'] ?? 0)
    const escrowed = Number(t['escrowed'] ?? 0)
    const portfolio = Number(t['portfolio_value'] ?? 0)
    // license_value is DERIVED (portfolio − cash): the ledger's writeTeamState keeps
    // portfolio_value fresh on every trade but never re-writes the stamped `license_value`
    // field, so reading that field directly would go stale after the first trade.
    return {
      ok: true as const,
      team_number: teamNumber,
      cash,
      escrowed,
      available: cash - escrowed,
      license_ids: (t['license_ids'] as string[] | undefined) ?? [],
      license_value: portfolio - cash,
      portfolio_value: portfolio,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. getTeamHistory — the caller team's OWN transactions (as a party). The query itself is
//    the privacy boundary: only rows where the team is from_team or to_team are returned, so
//    prices reach only the two parties (deal/auction) and a losing bidder — never a party —
//    never appears. Swaps carry no price (null). NEVER returns bids, reserve, or the graph.
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetTeamHistory(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
    const { teamNumber } = await callerTeam(instanceRef, participantId)

    const txns = instanceRef.collection('transactions')
    const [fromSnap, toSnap] = await Promise.all([
      txns.where('from_team', '==', teamNumber).get(),
      txns.where('to_team', '==', teamNumber).get(),
    ])
    const byId = new Map<string, Record<string, unknown>>()
    for (const d of [...fromSnap.docs, ...toSnap.docs]) byId.set(d.id, d.data())

    const rows = [...byId.entries()]
      .map(([id, d]) => ({
        transaction_id: id,
        type: d['type'] as string,
        from_team: (d['from_team'] as number | null) ?? null,
        to_team: (d['to_team'] as number | null) ?? null,
        region: (d['region'] as string | undefined) ?? null,
        quantity: (d['quantity'] as number | undefined) ?? null,
        region_x: (d['region_x'] as string | undefined) ?? null,
        quantity_x: (d['quantity_x'] as number | undefined) ?? null,
        region_y: (d['region_y'] as string | undefined) ?? null,
        quantity_y: (d['quantity_y'] as number | undefined) ?? null,
        price: (d['price'] as number | null | undefined) ?? null, // null for swaps
        at: toMillis(d['at']),
      }))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

    return { ok: true as const, team_number: teamNumber, rows }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. getTeamsDirectory — the public team→names roster (v3 §11.3). NAMES ONLY: never a
//    portfolio, cash, password, or synergy. Gated behind student auth so it is unreachable
//    from an unauthenticated session (privacy-walk leg 5 asserts exactly this).
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetTeamsDirectory(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)

    const [groupsSnap, partsSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('participants').get(),
    ])
    const nameOf = (pid: string): string => {
      const d = partsSnap.docs.find((p) => p.id === pid)?.data() ?? {}
      return String(d['display_name'] ?? d['name'] ?? '').trim()
    }

    const teams = groupsSnap.docs
      .map((d) => d.data())
      .filter((g) => g['team_number'] != null)
      .map((g) => ({
        team_number: g['team_number'] as number,
        member_names: ((g['trader_participants'] as string[] | undefined) ?? [])
          .map(nameOf)
          .filter((n) => n.length > 0),
      }))
      .sort((a, b) => a.team_number - b.team_number)

    return { ok: true as const, teams }
  })
}
