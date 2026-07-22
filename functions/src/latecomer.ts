// Spectrum latecomer placement hooks (Latecomer_Placement_Spec_v1 §3.1). Wired
// onto spectrumGameDef; consumed by the shared placeLatecomer via the code-entry
// path (makeVerifyAttendanceCode). Spectrum is the read-then-write onPlace case:
// a latecomer joins an existing team and inherits that team's CURRENT truth state.
//
// Does NOT modify grouping (makeGroupParticipants). onPlace only READS the team
// truth doc; it never writes it, so cash conservation and every ledger invariant
// are untouched at the join moment (audit 0c + finding 5).

import * as admin from 'firebase-admin'
import type { JoinableContext, PlaceContext, PlacementParticipant } from '@mygames/game-server'

// The team's server-authoritative ledger doc id (matches grouping.ts TRUTH_DOC).
const TRUTH_DOC = 'team'

/**
 * Joinable for the WHOLE market, but NOT once it has closed. The group doc status
 * is permanently 'matched' (the market lifecycle grouped→open→closed lives on
 * market/state, not the group), so the guard reads market/state.status — a
 * latecomer arriving after close falls through to absent + the terminal message.
 * Async, evaluated in the placement transaction's read phase (like eBay's clock).
 */
export async function spectrumIsJoinable(
  _group: admin.firestore.DocumentData,
  ctx: JoinableContext,
): Promise<boolean> {
  const state = (await admin.firestore()
    .collection('game_instances').doc(ctx.gameInstanceId)
    .collection('market').doc('state').get()).data()
  // Missing state ⇒ not yet closed ⇒ joinable (safe default; after grouping the
  // doc always exists, holding 'grouped' | 'open' | 'closed').
  return state?.['status'] !== 'closed'
}

/**
 * Stamp the latecomer's participant mirror to match a grouped member's, from the
 * team's CURRENT truth. ONE read (the chosen team's truth doc) then ONE write
 * (the participant mirror) — never the truth doc. Static fields (team_number,
 * password, synergy, endowment_regions) inherit as-is; the live fields (cash,
 * license_ids, portfolio_value, license_value) come from current truth so a
 * latecomer never sees the initial 1400/endowment tile. LOAD-BEARING:
 * team_password (no trade without it) and team_synergy (no valuation without it).
 *
 * Read-then-write inside the placement transaction (ctx.tx.get BEFORE the write) —
 * the exact path built and emu-tested in steps 1-3.
 */
export async function spectrumOnPlace(
  _group: admin.firestore.DocumentData,
  _participant: PlacementParticipant,
  ctx: PlaceContext,
): Promise<void> {
  const truth = (await ctx.tx.get(ctx.groupRef.collection('truth').doc(TRUTH_DOC))).data()
  if (!truth) {
    // Defensive: a grouped team always has its truth doc. Never fabricate one.
    console.error('[spectrumOnPlace] team truth doc missing; skipping mirror stamp')
    return
  }
  ctx.tx.update(ctx.participantRef, {
    // static — inherited as-is
    team_number:            truth['team_number'],
    team_password:          truth['password'],
    team_synergy:           truth['synergy'],
    team_endowment_regions: truth['endowment_regions'],
    // from CURRENT truth (mutate with trading)
    team_license_ids:       truth['license_ids'],
    team_cash:              truth['cash'],
    team_license_value:     truth['license_value'],
    team_portfolio_value:   truth['portfolio_value'],
  })
}
