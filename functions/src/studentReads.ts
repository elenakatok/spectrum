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
// 3. getTeamsDirectory — the public team→names roster (v3 §11.3). NAMES ONLY for
//    every team except the caller's own, which additionally carries member EMAILS
//    so a student can find their own teammates before the market opens. Gated
//    behind student auth so it is unreachable from an unauthenticated session
//    (privacy-walk leg 5 asserts exactly this).
//
//    OWN TEAM ONLY, and deliberately so. Reaching ANOTHER team is not an email
//    problem — Spectrum's mechanic is walking over in person, which the
//    counterparty-typed password exists to force. Other teams therefore return
//    email: null, never an address.
//
//    The caller's team is resolved SERVER-SIDE by finding the group whose
//    trader_participants contains the authenticated participantId. No team
//    identifier is read from the request, so there is no parameter a student can
//    supply to be treated as a member of a team they are not on — the standing
//    rule for all three of these read-only callables.
//
//    Wire shape is ADDITIVE: member_names stays exactly as it was (all teams,
//    names only) and members[] is new alongside it. That keeps a frontend
//    deployed before the functions working, and a frontend deployed after them
//    working too, in either deploy order.
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetTeamsDirectory(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)

    const [groupsSnap, partsSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('participants').get(),
    ])

    const partById = new Map(partsSnap.docs.map((p) => [p.id, p.data()]))
    const nameOf = (pid: string): string =>
      String(partById.get(pid)?.['display_name'] ?? partById.get(pid)?.['name'] ?? '').trim()
    // Legacy participants predate email on the roster; absent or blank yields
    // null, which the client renders as nothing rather than an empty line.
    const emailOf = (pid: string): string | null =>
      String(partById.get(pid)?.['email'] ?? '').trim() || null

    const groups = groupsSnap.docs.map((d) => d.data()).filter((g) => g['team_number'] != null)

    const membersOf = (g: Record<string, unknown>): string[] =>
      (g['trader_participants'] as string[] | undefined) ?? []

    const ownTeamNumber = groups.find((g) => membersOf(g).includes(participantId))?.['team_number'] ?? null

    const teams = groups
      .map((g) => {
        const isOwnTeam = ownTeamNumber != null && g['team_number'] === ownTeamNumber
        const named = membersOf(g)
          .map((pid) => ({ pid, name: nameOf(pid) }))
          .filter((m) => m.name.length > 0)
        return {
          team_number: g['team_number'] as number,
          member_names: named.map((m) => m.name),
          members: named.map((m) => ({
            name: m.name,
            email: isOwnTeam ? emailOf(m.pid) : null,
          })),
        }
      })
      .sort((a, b) => a.team_number - b.team_number)

    return { ok: true as const, own_team_number: ownTeamNumber, teams }
  })
}
