// Spectrum ledger core — Slice 1. THREE transactional callables. No UI.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §5–§8 + the Slice 1 prompt.
//
// Every mutation is ONE Firestore transaction that re-verifies all preconditions on the
// documents it will write (invariant 6 — sufficiency at execute time). That re-read is
// what closes the legacy check-then-act races: a concurrent transaction that touched any
// license or truth doc in this read set forces an abort+retry, on which we re-validate
// against the fresh state. All seven invariants hold INSIDE the transaction.
//
// The license doc `owner_team` is the ONLY ownership truth (invariant 1); truth.license_ids
// and group.license_ids are derived caches recomputed in the SAME transaction. `escrowed`
// on the truth doc is Σ of the team's own live auction bids; available = cash − escrowed.

import { randomUUID } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, extractInstructorGameId } from '@mygames/game-server'
import type { GameDefinition } from '@mygames/game-server'
import { normalizePassword } from './synergy'
import { portfolioValueFor, determineAuctionWinner, type SynergyRow, type TeamBid } from './ledgerCore'

type Ref = admin.firestore.DocumentReference
type Tx = admin.firestore.Transaction

const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'
const authHeaderOf = (req: { rawRequest: { headers: Record<string, unknown> } }) =>
  req.rawRequest.headers.authorization as string | undefined

/** Resolve a team number -> its group id (teams are fixed after grouping). */
async function groupIdForTeam(
  instanceRef: Ref,
  teamNumber: number,
): Promise<string | null> {
  const snap = await instanceRef.collection('groups').where('team_number', '==', teamNumber).limit(1).get()
  return snap.empty ? null : snap.docs[0].id
}

/** Map every team number -> group id in one read (for settlement fan-out). */
async function teamGroupMap(instanceRef: Ref): Promise<Map<number, string>> {
  const snap = await instanceRef.collection('groups').get()
  const m = new Map<number, string>()
  for (const d of snap.docs) {
    const n = d.data()['team_number'] as number | undefined
    if (n != null) m.set(n, d.id)
  }
  return m
}

const truthRef = (instanceRef: Ref, groupId: string): Ref =>
  instanceRef.collection('groups').doc(groupId).collection('truth').doc('team')

/** Read a team's full holdings (source of truth) inside the transaction. */
async function readHoldings(tx: Tx, instanceRef: Ref, teamNumber: number) {
  const snap = await tx.get(instanceRef.collection('licenses').where('owner_team', '==', teamNumber))
  return snap.docs.map((d) => ({
    id: d.id,
    region: d.data()['region'] as string,
    under_auction: (d.data()['under_auction'] as string | null) ?? null,
  }))
}

async function requireMarketOpen(instanceRef: Ref): Promise<void> {
  const snap = await instanceRef.collection('market').doc('state').get()
  if ((snap.data()?.['status'] as string | undefined) !== 'open') {
    throw new HttpsError('failed-precondition', 'The market is not open.')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. executeDeal — licenses for cash. Called by a SELLER-team member.
// ─────────────────────────────────────────────────────────────────────────────
export function makeExecuteDeal(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))

    const region = String(data['region'] ?? '')
    const quantity = Number(data['quantity'])
    const price = Number(data['price'])
    const buyerTeam = Number(data['buyerTeam'])
    const buyerPassword = String(data['buyerPassword'] ?? '')
    if (!region) throw new HttpsError('invalid-argument', 'region is required')
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpsError('invalid-argument', 'quantity must be a positive integer')
    if (!Number.isFinite(price) || price < 0) throw new HttpsError('invalid-argument', 'price must be >= 0')
    if (!Number.isInteger(buyerTeam) || buyerTeam < 1) throw new HttpsError('invalid-argument', 'buyerTeam must be a positive integer')

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      await requireMarketOpen(instanceRef)

      const partSnap = await instanceRef.collection('participants').doc(participantId).get()
      const sellerGroupId = partSnap.data()?.['group_id'] as string | undefined
      const sellerTeam = partSnap.data()?.['team_number'] as number | undefined
      if (!sellerGroupId || sellerTeam == null) throw new HttpsError('failed-precondition', 'You are not on a team.')
      if (buyerTeam === sellerTeam) throw new HttpsError('invalid-argument', 'You cannot deal with your own team.')

      const buyerGroupId = await groupIdForTeam(instanceRef, buyerTeam)
      if (!buyerGroupId) throw new HttpsError('invalid-argument', 'Unknown team.')

      const sellerTruthRef = truthRef(instanceRef, sellerGroupId)
      const buyerTruthRef = truthRef(instanceRef, buyerGroupId)

      return await db.runTransaction(async (tx) => {
        // ── READS (all before any write) ──
        const [sellerTruthSnap, buyerTruthSnap, sellerHoldings, buyerHoldings] = await Promise.all([
          tx.get(sellerTruthRef),
          tx.get(buyerTruthRef),
          readHoldings(tx, instanceRef, sellerTeam),
          readHoldings(tx, instanceRef, buyerTeam),
        ])
        const sellerTruth = sellerTruthSnap.data() ?? {}
        const buyerTruth = buyerTruthSnap.data() ?? {}

        // Password: the counterparty (buyer) authorizes. Non-leaking on failure.
        if (normalizePassword(buyerPassword) !== normalizePassword(String(buyerTruth['password'] ?? ''))) {
          throw new HttpsError('permission-denied', 'Password not recognized.')
        }

        // Seller sufficiency: free (not under auction) licenses in the region.
        const ownedInRegion = sellerHoldings.filter((l) => l.region === region)
        const free = ownedInRegion.filter((l) => l.under_auction == null).map((l) => l.id).sort()
        if (free.length < quantity) {
          if (ownedInRegion.length >= quantity) {
            throw new HttpsError('failed-precondition', 'Those licenses are currently under auction.')
          }
          throw new HttpsError('failed-precondition', `You no longer hold ${quantity} licenses in Region ${region}.`)
        }

        // Buyer sufficiency: available = cash − escrowed. Non-leaking message.
        const buyerCash = Number(buyerTruth['cash'] ?? 0)
        const buyerEscrow = Number(buyerTruth['escrowed'] ?? 0)
        if (buyerCash - buyerEscrow < price) {
          throw new HttpsError('failed-precondition', `Team ${buyerTeam} does not have sufficient available funds.`)
        }

        const moved = free.slice(0, quantity)
        const movedSet = new Set(moved)
        const sellerAfter = sellerHoldings.map((l) => l.id).filter((id) => !movedSet.has(id))
        const buyerAfter = [...buyerHoldings.map((l) => l.id), ...moved]
        const sellerCashAfter = Number(sellerTruth['cash'] ?? 0) + price
        const buyerCashAfter = buyerCash - price

        // ── WRITES ──
        for (const id of moved) tx.update(instanceRef.collection('licenses').doc(id), { owner_team: buyerTeam })
        writeTeamState(tx, instanceRef, sellerGroupId, sellerTruthRef, sellerCashAfter, sellerAfter, (sellerTruth['synergy'] as SynergyRow[]) ?? [])
        writeTeamState(tx, instanceRef, buyerGroupId, buyerTruthRef, buyerCashAfter, buyerAfter, (buyerTruth['synergy'] as SynergyRow[]) ?? [])

        const txId = randomUUID()
        tx.set(instanceRef.collection('transactions').doc(txId), {
          transaction_id: txId, type: 'deal',
          from_team: sellerTeam, to_team: buyerTeam,
          region, quantity, price, license_ids: moved,
          acted_by: participantId, authorized_by: buyerTeam,
          at: FieldValue.serverTimestamp(),
        })
        return { ok: true as const, transaction_id: txId, moved }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[executeDeal] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. executeSwap — licenses for licenses, NO cash. Called by the INITIATOR team.
// ─────────────────────────────────────────────────────────────────────────────
export function makeExecuteSwap(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))

    const regionX = String(data['regionX'] ?? '')
    const quantityX = Number(data['quantityX'])
    const regionY = String(data['regionY'] ?? '')
    const quantityY = Number(data['quantityY'])
    const partnerTeam = Number(data['partnerTeam'])
    const partnerPassword = String(data['partnerPassword'] ?? '')
    if (!regionX || !regionY) throw new HttpsError('invalid-argument', 'regionX and regionY are required')
    if (!Number.isInteger(quantityX) || quantityX < 1) throw new HttpsError('invalid-argument', 'quantityX must be a positive integer')
    if (!Number.isInteger(quantityY) || quantityY < 1) throw new HttpsError('invalid-argument', 'quantityY must be a positive integer')
    if (!Number.isInteger(partnerTeam) || partnerTeam < 1) throw new HttpsError('invalid-argument', 'partnerTeam must be a positive integer')

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      await requireMarketOpen(instanceRef)

      const partSnap = await instanceRef.collection('participants').doc(participantId).get()
      const initGroupId = partSnap.data()?.['group_id'] as string | undefined
      const initTeam = partSnap.data()?.['team_number'] as number | undefined
      if (!initGroupId || initTeam == null) throw new HttpsError('failed-precondition', 'You are not on a team.')
      if (partnerTeam === initTeam) throw new HttpsError('invalid-argument', 'You cannot swap with your own team.')

      const partnerGroupId = await groupIdForTeam(instanceRef, partnerTeam)
      if (!partnerGroupId) throw new HttpsError('invalid-argument', 'Unknown team.')

      const initTruthRef = truthRef(instanceRef, initGroupId)
      const partnerTruthRef = truthRef(instanceRef, partnerGroupId)

      return await db.runTransaction(async (tx) => {
        const [initTruthSnap, partnerTruthSnap, initHoldings, partnerHoldings] = await Promise.all([
          tx.get(initTruthRef),
          tx.get(partnerTruthRef),
          readHoldings(tx, instanceRef, initTeam),
          readHoldings(tx, instanceRef, partnerTeam),
        ])
        const initTruth = initTruthSnap.data() ?? {}
        const partnerTruth = partnerTruthSnap.data() ?? {}

        if (normalizePassword(partnerPassword) !== normalizePassword(String(partnerTruth['password'] ?? ''))) {
          throw new HttpsError('permission-denied', 'Password not recognized.')
        }

        const initFree = pickFree(initHoldings, regionX, quantityX, 'You')
        const partnerFree = pickFree(partnerHoldings, regionY, quantityY, `Team ${partnerTeam}`)

        const movedXset = new Set(initFree) // init -> partner
        const movedYset = new Set(partnerFree) // partner -> init
        const initAfter = [...initHoldings.map((l) => l.id).filter((id) => !movedXset.has(id)), ...partnerFree]
        const partnerAfter = [...partnerHoldings.map((l) => l.id).filter((id) => !movedYset.has(id)), ...initFree]

        // ── WRITES ── (one transaction — both legs atomic; cash unchanged)
        for (const id of initFree) tx.update(instanceRef.collection('licenses').doc(id), { owner_team: partnerTeam })
        for (const id of partnerFree) tx.update(instanceRef.collection('licenses').doc(id), { owner_team: initTeam })
        writeTeamState(tx, instanceRef, initGroupId, initTruthRef, Number(initTruth['cash'] ?? 0), initAfter, (initTruth['synergy'] as SynergyRow[]) ?? [])
        writeTeamState(tx, instanceRef, partnerGroupId, partnerTruthRef, Number(partnerTruth['cash'] ?? 0), partnerAfter, (partnerTruth['synergy'] as SynergyRow[]) ?? [])

        const txId = randomUUID()
        tx.set(instanceRef.collection('transactions').doc(txId), {
          transaction_id: txId, type: 'swap',
          from_team: initTeam, to_team: partnerTeam,
          region_x: regionX, quantity_x: quantityX, license_ids_x: initFree,
          region_y: regionY, quantity_y: quantityY, license_ids_y: partnerFree,
          price: null,
          acted_by: participantId, authorized_by: partnerTeam,
          at: FieldValue.serverTimestamp(),
        })
        return { ok: true as const, transaction_id: txId, gave: initFree, got: partnerFree }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[executeSwap] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. settleAuction — the idempotent settlement PRIMITIVE (Slice 2 drives the lifecycle).
//    Called with an ended auction's id. Instructor/internal auth (in Slice 2 this fires
//    from a Cloud Task + a resolve-on-read backstop).
// ─────────────────────────────────────────────────────────────────────────────
export function makeSettleAuction(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const auctionId = String(data['auction_id'] ?? data['auctionId'] ?? '')
    if (!auctionId) throw new HttpsError('invalid-argument', 'auction_id is required')

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      const auctionRef = instanceRef.collection('auctions').doc(auctionId)
      const teamMap = await teamGroupMap(instanceRef) // fixed team->group

      return await db.runTransaction(async (tx) => {
        // ── READS ──
        const auctionSnap = await tx.get(auctionRef)
        if (!auctionSnap.exists) throw new HttpsError('not-found', 'Auction not found.')
        const auction = auctionSnap.data() as Record<string, unknown>

        // Idempotency guard — inside the transaction, anchored on the auction doc.
        const status = auction['status'] as string
        if (status !== 'open') {
          return {
            ok: true as const, alreadySettled: true, status,
            winner_team: (auction['winner_team'] as number | null) ?? null,
            clearing_price: (auction['clearing_price'] as number | null) ?? null,
          }
        }

        const endsAt = auction['ends_at'] as Timestamp | undefined
        if (endsAt && endsAt.toMillis() > Timestamp.now().toMillis()) {
          throw new HttpsError('failed-precondition', 'Auction has not ended.')
        }

        const sellerTeam = auction['seller_team'] as number
        const reserve = Number(auction['reserve'] ?? 0)
        const auctionLicenseIds = (auction['license_ids'] as string[] | undefined) ?? []

        const bidsSnap = await tx.get(auctionRef.collection('bids'))
        const bids: TeamBid[] = bidsSnap.docs.map((d) => ({
          teamNumber: d.data()['team_number'] as number,
          amount: Number(d.data()['amount']),
          atMs: Number(d.data()['at']),
        }))
        const bidByTeam = new Map(bids.map((b) => [b.teamNumber, b.amount]))

        const { winnerTeam, clearingPrice } = determineAuctionWinner(bids, reserve)

        // Gather the truth refs we may touch: seller, winner, and every bidder (escrow release).
        const involved = new Set<number>([sellerTeam, ...bids.map((b) => b.teamNumber)])
        if (winnerTeam != null) involved.add(winnerTeam)
        const truthRefByTeam = new Map<number, Ref>()
        for (const t of involved) {
          const gid = teamMap.get(t)
          if (gid) truthRefByTeam.set(t, truthRef(instanceRef, gid))
        }
        const truthSnaps = new Map<number, admin.firestore.DocumentSnapshot>()
        for (const [t, ref] of truthRefByTeam) truthSnaps.set(t, await tx.get(ref))

        // Holdings of seller + winner (needed to recompute their portfolios).
        const holdingsByTeam = new Map<number, string[]>()
        holdingsByTeam.set(sellerTeam, (await readHoldings(tx, instanceRef, sellerTeam)).map((l) => l.id))
        if (winnerTeam != null && winnerTeam !== sellerTeam) {
          holdingsByTeam.set(winnerTeam, (await readHoldings(tx, instanceRef, winnerTeam)).map((l) => l.id))
        }

        const settledAt = FieldValue.serverTimestamp()
        const groupIdOf = (t: number) => teamMap.get(t)!

        if (winnerTeam == null) {
          // ── NO SALE — release every bidder's escrow; licenses return to free state. ──
          for (const b of bids) {
            const snap = truthSnaps.get(b.teamNumber)!
            const esc = Number(snap.data()?.['escrowed'] ?? 0)
            tx.update(truthRefByTeam.get(b.teamNumber)!, { escrowed: esc - b.amount })
          }
          for (const id of auctionLicenseIds) {
            tx.update(instanceRef.collection('licenses').doc(id), { under_auction: null })
          }
          tx.update(auctionRef, { status: 'no_sale', winner_team: null, clearing_price: null, settled_at: settledAt })
          return { ok: true as const, alreadySettled: false, status: 'no_sale', winner_team: null, clearing_price: null }
        }

        // ── SALE — winner takes the whole lot at their bid; escrows released. ──
        const price = clearingPrice ?? 0
        // Move the lot: seller -> winner, clear the auction lock.
        for (const id of auctionLicenseIds) {
          tx.update(instanceRef.collection('licenses').doc(id), { owner_team: winnerTeam, under_auction: null })
        }
        const lotSet = new Set(auctionLicenseIds)
        const sellerAfter = holdingsByTeam.get(sellerTeam)!.filter((id) => !lotSet.has(id))
        const winnerAfter = [...holdingsByTeam.get(winnerTeam)!, ...auctionLicenseIds]

        // Escrow release for every bidder; winner additionally PAYS their bid.
        for (const b of bids) {
          const snap = truthSnaps.get(b.teamNumber)!
          const esc = Number(snap.data()?.['escrowed'] ?? 0)
          tx.update(truthRefByTeam.get(b.teamNumber)!, { escrowed: esc - b.amount })
        }

        // Cash: winner −= price, seller += price (net zero → cash conservation holds).
        const winnerSnap = truthSnaps.get(winnerTeam)!
        const sellerSnap = truthSnaps.get(sellerTeam)!
        const winnerCashAfter = Number(winnerSnap.data()?.['cash'] ?? 0) - price
        const sellerCashAfter = Number(sellerSnap.data()?.['cash'] ?? 0) + price
        writeTeamState(tx, instanceRef, groupIdOf(winnerTeam), truthRefByTeam.get(winnerTeam)!, winnerCashAfter, winnerAfter, (winnerSnap.data()?.['synergy'] as SynergyRow[]) ?? [])
        writeTeamState(tx, instanceRef, groupIdOf(sellerTeam), truthRefByTeam.get(sellerTeam)!, sellerCashAfter, sellerAfter, (sellerSnap.data()?.['synergy'] as SynergyRow[]) ?? [])

        tx.update(auctionRef, { status: 'settled', winner_team: winnerTeam, clearing_price: price, settled_at: settledAt })

        const txId = randomUUID()
        tx.set(instanceRef.collection('transactions').doc(txId), {
          transaction_id: txId, type: 'auction',
          from_team: sellerTeam, to_team: winnerTeam,
          region: auction['region'] as string, quantity: auction['quantity'] as number,
          price, license_ids: auctionLicenseIds,
          acted_by: null, authorized_by: winnerTeam, auction_id: auctionId,
          at: FieldValue.serverTimestamp(),
        })
        void bidByTeam
        return { ok: true as const, alreadySettled: false, status: 'settled', winner_team: winnerTeam, clearing_price: price }
      })
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[settleAuction] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}

// ── shared write helper: recompute + persist a team's cash/holdings/portfolio ──
function writeTeamState(
  tx: Tx,
  instanceRef: Ref,
  groupId: string,
  teamTruthRef: Ref,
  cash: number,
  licenseIds: string[],
  synergy: SynergyRow[],
): void {
  const sorted = [...licenseIds].sort()
  tx.update(teamTruthRef, {
    cash,
    license_ids: sorted,
    portfolio_value: portfolioValueFor(cash, sorted, synergy),
  })
  tx.update(instanceRef.collection('groups').doc(groupId), { license_ids: sorted })
}

// ── pick `quantity` free (not-under-auction) license ids in a region, or throw ──
function pickFree(
  holdings: Array<{ id: string; region: string; under_auction: string | null }>,
  region: string,
  quantity: number,
  who: string,
): string[] {
  const ownedInRegion = holdings.filter((l) => l.region === region)
  const free = ownedInRegion.filter((l) => l.under_auction == null).map((l) => l.id).sort()
  if (free.length < quantity) {
    if (ownedInRegion.length >= quantity) {
      throw new HttpsError('failed-precondition', 'Those licenses are currently under auction.')
    }
    throw new HttpsError('failed-precondition', `${who} no longer hold ${quantity} licenses in Region ${region}.`)
  }
  return free.slice(0, quantity)
}
