// Spectrum auction lifecycle — Slice 2. create → bid → getState → close.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §7 + the Slice 2 prompt. Still NO UI.
//
// The close has TWO triggers, ONE settle: a Cloud Task scheduled at endsAt (primary,
// timely) and resolve-on-read (backstop, guaranteed). BOTH call the shared runSettlement
// core (Slice 1, extracted in Slice 2 — behavior re-proven by the 50-test regression),
// which is idempotent, so running both is safe.

import { randomUUID } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getFunctions } from 'firebase-admin/functions'
import { extractStudentOnCallIds } from '@mygames/game-server'
import type { GameDefinition } from '@mygames/game-server'
import { DEFAULT_AUCTION_DURATION_MINUTES } from './synergy'
import { auctionEndsBeforeCutoff, AUCTION_CUTOFF_MINUTES } from './ledgerCore'
import { runSettlement, readHoldings, truthRef, isEmu, authHeaderOf } from './ledger'

const bidDocId = (team: number) => `team-${team}`

// ── The resolve-on-read BACKSTOP — settle any ended-but-live auction before reading it. ──
export async function settleIfEnded(gameInstanceId: string, auctionId: string): Promise<void> {
  const db = admin.firestore()
  const ref = db.collection('game_instances').doc(gameInstanceId).collection('auctions').doc(auctionId)
  const snap = await ref.get()
  if (!snap.exists) return
  const d = snap.data() as Record<string, unknown>
  const endsAtMs = (d['ends_at'] as Timestamp | undefined)?.toMillis?.() ?? Infinity
  // 'open' is the pre-settle auction status — matching runSettlement's idempotency guard
  // (Slice 1, unchanged: it settles only status 'open', treats anything else as done).
  if (d['status'] === 'open' && endsAtMs <= Timestamp.now().toMillis()) {
    try { await runSettlement(gameInstanceId, auctionId) }
    catch (err) { if (!(err instanceof HttpsError)) console.error('[settleIfEnded] error:', err) }
  }
}

// ── Cloud Task enqueue (best-effort — the backstop guarantees settlement regardless). ──
async function enqueueSettleTask(gameInstanceId: string, auctionId: string, scheduleMs: number): Promise<void> {
  try {
    const queue = getFunctions().taskQueue('settleAuctionTask')
    await queue.enqueue({ game_instance_id: gameInstanceId, auction_id: auctionId }, { scheduleTime: new Date(scheduleMs) })
  } catch (err) {
    // Missing/unavailable task queue must NOT fail auction creation — resolve-on-read covers it.
    console.warn('[createAuction] settle-task enqueue skipped:', err instanceof Error ? err.message : err)
  }
}

// ── PRIMARY close trigger: the Cloud Task handler → the same shared runSettlement core. ──
export const settleAuctionTask = onTaskDispatched(
  { retryConfig: { maxAttempts: 5, minBackoffSeconds: 5 }, rateLimits: { maxConcurrentDispatches: 6 } },
  async (req) => {
    const { game_instance_id, auction_id } = (req.data ?? {}) as { game_instance_id?: string; auction_id?: string }
    if (!game_instance_id || !auction_id) return
    try {
      await runSettlement(game_instance_id, auction_id)
    } catch (err) {
      // 'Auction has not ended' (early fire / skew) → rethrow so Cloud Tasks retries.
      if (err instanceof HttpsError && err.code === 'failed-precondition') throw err
      if (!(err instanceof HttpsError)) console.error('[settleAuctionTask] error:', err)
    }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// 1. createAuction — seller lists a lot, licenses lock, endsAt set, task enqueued.
// ─────────────────────────────────────────────────────────────────────────────
export function makeCreateAuction(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))

    const region = String(data['region'] ?? '')
    const quantity = Number(data['quantity'])
    const reserve = data['reserve'] == null ? 0 : Number(data['reserve'])
    if (!region) throw new HttpsError('invalid-argument', 'region is required')
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpsError('invalid-argument', 'quantity must be a positive integer')
    if (!Number.isFinite(reserve) || reserve < 0) throw new HttpsError('invalid-argument', 'reserve must be >= 0')

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // Market open + the CUTOFF rule (server-enforced — the legacy never had this).
    const state = (await instanceRef.collection('market').doc('state').get()).data() as Record<string, unknown> | undefined
    if ((state?.['status'] as string) !== 'open') throw new HttpsError('failed-precondition', 'The market is not open.')
    const closesAtMs = (state?.['closes_at'] as Timestamp | undefined)?.toMillis?.()
    if (closesAtMs == null) throw new HttpsError('failed-precondition', 'The market has no close time.')
    const durationMin = Number(state?.['auction_duration_minutes'] ?? DEFAULT_AUCTION_DURATION_MINUTES)
    const nowMs = Timestamp.now().toMillis()
    if (!auctionEndsBeforeCutoff(nowMs, durationMin, closesAtMs, AUCTION_CUTOFF_MINUTES)) {
      throw new HttpsError('failed-precondition', 'This auction cannot finish before the market closes.')
    }

    const partSnap = await instanceRef.collection('participants').doc(participantId).get()
    const sellerTeam = partSnap.data()?.['team_number'] as number | undefined
    if (sellerTeam == null) throw new HttpsError('failed-precondition', 'You are not on a team.')

    const auctionId = randomUUID()
    const endsAt = Timestamp.fromMillis(nowMs + durationMin * 60_000)

    try {
      await db.runTransaction(async (tx) => {
        const holdings = await readHoldings(tx, instanceRef, sellerTeam)
        const ownedInRegion = holdings.filter((l) => l.region === region)
        const free = ownedInRegion.filter((l) => l.under_auction == null).map((l) => l.id).sort()
        if (free.length < quantity) {
          if (ownedInRegion.length >= quantity) {
            throw new HttpsError('failed-precondition', 'Those licenses are already under auction.')
          }
          throw new HttpsError('failed-precondition', `You do not hold ${quantity} licenses in Region ${region}.`)
        }
        const lot = free.slice(0, quantity)
        for (const id of lot) tx.update(instanceRef.collection('licenses').doc(id), { under_auction: auctionId })
        tx.set(instanceRef.collection('auctions').doc(auctionId), {
          auction_id: auctionId, region, quantity, seller_team: sellerTeam,
          reserve, license_ids: lot, status: 'open', // pre-settle status (matches runSettlement)
          ends_at: endsAt, created_at: FieldValue.serverTimestamp(),
          winner_team: null, clearing_price: null,
        })
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[createAuction] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }

    await enqueueSettleTask(gameInstanceId, auctionId, endsAt.toMillis())
    return { ok: true as const, auction_id: auctionId, ends_at: endsAt.toMillis() }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. placeBid — sealed, one per team per auction, no revisions; escrows the amount.
// ─────────────────────────────────────────────────────────────────────────────
export function makePlaceBid(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const auctionId = String(data['auction_id'] ?? '')
    const amount = Number(data['amount'])
    if (!auctionId) throw new HttpsError('invalid-argument', 'auction_id is required')
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpsError('invalid-argument', 'amount must be > 0')

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // BACKSTOP: settle first if it has already ended (then the bid is correctly rejected).
    await settleIfEnded(gameInstanceId, auctionId)

    const partSnap = await instanceRef.collection('participants').doc(participantId).get()
    const callerGroupId = partSnap.data()?.['group_id'] as string | undefined
    const callerTeam = partSnap.data()?.['team_number'] as number | undefined
    if (!callerGroupId || callerTeam == null) throw new HttpsError('failed-precondition', 'You are not on a team.')

    const auctionRef = instanceRef.collection('auctions').doc(auctionId)
    const truthR = truthRef(instanceRef, callerGroupId)
    const bidRef = auctionRef.collection('bids').doc(bidDocId(callerTeam))

    try {
      return await db.runTransaction(async (tx) => {
        const [aSnap, tSnap, bSnap] = await Promise.all([tx.get(auctionRef), tx.get(truthR), tx.get(bidRef)])
        if (!aSnap.exists) throw new HttpsError('not-found', 'Auction not found.')
        const a = aSnap.data() as Record<string, unknown>
        if ((a['seller_team'] as number) === callerTeam) throw new HttpsError('failed-precondition', 'You cannot bid on your own auction.')
        const endsAtMs = (a['ends_at'] as Timestamp).toMillis()
        if (a['status'] !== 'open' || endsAtMs <= Timestamp.now().toMillis()) throw new HttpsError('failed-precondition', 'This auction has ended.')
        if (bSnap.exists) throw new HttpsError('failed-precondition', 'You have already bid on this auction.')
        const cash = Number(tSnap.data()?.['cash'] ?? 0)
        const escrowed = Number(tSnap.data()?.['escrowed'] ?? 0)
        if (cash - escrowed < amount) throw new HttpsError('failed-precondition', 'You do not have sufficient available funds to bid.')

        tx.set(bidRef, { team_number: callerTeam, amount, at: Timestamp.now().toMillis(), acted_by: participantId })
        tx.update(truthR, { escrowed: escrowed + amount })
        return { ok: true as const, auction_id: auctionId, amount }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[placeBid] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. getAuctionState — paranoid visibility. Public: region/quantity/seller/time/exists.
//    NEVER: reserve, any bid amount, bid count, who bid. Caller sees only their OWN bid;
//    clearing price only to the winner or the seller (both parties to the sale).
// ─────────────────────────────────────────────────────────────────────────────
export function makeGetAuctionState(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const auctionId = String(data['auction_id'] ?? '')
    if (!auctionId) throw new HttpsError('invalid-argument', 'auction_id is required')

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    // BACKSTOP: any server touch of an ended auction settles it first.
    await settleIfEnded(gameInstanceId, auctionId)

    const snap = await instanceRef.collection('auctions').doc(auctionId).get()
    if (!snap.exists) throw new HttpsError('not-found', 'Auction not found.')
    const a = snap.data() as Record<string, unknown>

    const partSnap = await instanceRef.collection('participants').doc(participantId).get()
    const callerTeam = partSnap.data()?.['team_number'] as number | null ?? null
    const callerGroupId = partSnap.data()?.['group_id'] as string | undefined

    const nowMs = Timestamp.now().toMillis()
    const endsAtMs = (a['ends_at'] as Timestamp).toMillis()
    const status = a['status'] as string
    const sellerTeam = a['seller_team'] as number
    const winnerTeam = (a['winner_team'] as number | null) ?? null

    // PUBLIC only. Note the deliberate absences: reserve, bids, bid count, bidders.
    const res: Record<string, unknown> = {
      ok: true,
      auction_id: auctionId,
      region: a['region'],
      quantity: a['quantity'],
      seller_team: sellerTeam,
      status,
      time_remaining_ms: Math.max(0, endsAtMs - nowMs),
    }

    // Caller's OWN bid (read only their own bid doc) + their own available cash.
    if (callerTeam != null && callerTeam !== sellerTeam) {
      const bidSnap = await instanceRef.collection('auctions').doc(auctionId).collection('bids').doc(bidDocId(callerTeam)).get()
      if (bidSnap.exists) {
        res['your_bid'] = bidSnap.data()?.['amount']
        if (callerGroupId) {
          const t = (await instanceRef.collection('groups').doc(callerGroupId).collection('truth').doc('team').get()).data()
          if (t) res['your_available_cash'] = Number(t['cash'] ?? 0) - Number(t['escrowed'] ?? 0)
        }
      }
    }

    // After close: clearing price ONLY to a party (winner or seller). Losers learn only
    // that they lost — never the clearing price, never the other bids.
    if (status === 'settled') {
      const isParty = callerTeam === winnerTeam || callerTeam === sellerTeam
      if (isParty) res['clearing_price'] = a['clearing_price'] ?? null
      if (callerTeam != null && callerTeam !== sellerTeam) res['you_won'] = callerTeam === winnerTeam
    }

    return res
  })
}
