// ═══════════════════════════════════════════════════════════════════════════════
// AUCTION ENGINE — pure resolver (the file that becomes the shared engine).
//
// EXTRACTION DISCIPLINE (enforced):
//   • PURE FUNCTION. Imports NOTHING from firebase-admin / firebase-functions /
//     Firestore / RTDB. No Date.now(), no request objects, no I/O of any kind.
//     Inputs in, result out — copy-pasteable into a shared package with ZERO edits.
//   • Generic vocabulary only: bid / bidder / item / amount. No "price", "resale",
//     "French horn", "Bidder 1 (Expert)" — those live in the eBay strings layer.
//   • Namespaced by domain (`auction…`), never by game (`ebay…`).
//
// The resolver branches on AuctionSettings (direction / format / pricing). eBay
// pins them; unimplemented values throw. `format: 'sealed'` uses the SAME logic —
// sealed differs only in how bids are COLLECTED, not resolved.
// ═══════════════════════════════════════════════════════════════════════════════

import type { AuctionSettings } from './settings'

export interface AuctionBid {
  bidderIndex: number       // 1..N
  maxAmount: number         // the bidder's confidential proxy maximum
  serverTimestampMs: number // server-receipt time; used ONLY for tie-breaking
}

export interface AuctionEndowment {
  bidderIndex: number
  signal: number            // the bidder's BELIEF — NEVER used in resolution
  privateValue: number
  // The true common value lies within [signal − signalHalfWidth, signal + signalHalfWidth].
  // Bidder 1 has halfWidth 0 → their signal IS the truth. That is what makes them the
  // expert. Metadata for a future random-draw engine (uniform over that interval);
  // recorded here, NEVER consumed in resolution.
  signalHalfWidth: number
}

export interface AuctionResolution {
  winnerBidderIndex: number | null   // null = no sale
  clearingPrice: number | null       // null = no sale
  perBidder: Array<{
    bidderIndex: number
    realizedValue: number   // vCommon + privateValue (defined for ALL, even losers)
    profit: number          // winner: realizedValue - clearingPrice; losers: 0
  }>
}

/**
 * Resolve a single auction from each bidder's final/highest proxy max.
 *
 * @param bids          one entry per bidder = their FINAL (highest) max
 * @param endowments    per-bidder truth inputs (the canonical participant set)
 * @param vCommon       the common resale value (server-only truth)
 * @param settings      the pinned auction parameters (resolver branches on these)
 * @param startingPrice eBay: 0 — the single-bidder clearing-price fallback
 */
export function resolveAuction(
  bids: AuctionBid[],
  endowments: AuctionEndowment[],
  vCommon: number,
  settings: AuctionSettings,
  startingPrice: number,
): AuctionResolution {
  // Only 'ascending' is implemented; 'sealed' is resolved identically to 'open'.
  if (settings.direction === 'descending') {
    throw new Error('not implemented')
  }

  // realizedValue is defined for every endowed bidder, bidder or not, winner or
  // loser. `signal` is deliberately NOT read — it is belief, not truth.
  const realizedValueByIndex = new Map<number, number>()
  for (const e of endowments) {
    realizedValueByIndex.set(e.bidderIndex, vCommon + e.privateValue)
  }
  const realizedFor = (bidderIndex: number): number =>
    realizedValueByIndex.get(bidderIndex) ?? vCommon

  // No bids → no sale; every bidder profits 0.
  if (bids.length === 0) {
    return {
      winnerBidderIndex: null,
      clearingPrice: null,
      perBidder: endowments.map(e => ({
        bidderIndex: e.bidderIndex,
        realizedValue: realizedFor(e.bidderIndex),
        profit: 0,
      })),
    }
  }

  // Rank bids: highest maxAmount wins; ties broken by earliest serverTimestampMs.
  const ranked = [...bids].sort((a, b) =>
    b.maxAmount - a.maxAmount || a.serverTimestampMs - b.serverTimestampMs,
  )
  const winner = ranked[0]
  const runnerUpMax: number | null = ranked.length > 1 ? ranked[1].maxAmount : null

  // Clearing price per the pinned pricing rule. `min(winnerMax, …)` guarantees the
  // price never exceeds the winner's own max (the tie-case cap falls out for free).
  let clearingPrice: number
  if (settings.pricing === 'second') {
    clearingPrice = runnerUpMax === null
      ? startingPrice                                        // single bidder → fallback
      : Math.min(winner.maxAmount, runnerUpMax + settings.increment)
  } else {
    // 'first' price — winner pays their own max. Implemented but unused by eBay.
    clearingPrice = winner.maxAmount
  }

  return {
    winnerBidderIndex: winner.bidderIndex,
    clearingPrice,
    perBidder: endowments.map(e => {
      const realizedValue = realizedFor(e.bidderIndex)
      const isWinner = e.bidderIndex === winner.bidderIndex
      // Winner profit MAY be negative (winner's curse) — DO NOT CLAMP.
      return {
        bidderIndex: e.bidderIndex,
        realizedValue,
        profit: isWinner ? realizedValue - clearingPrice : 0,
      }
    }),
  }
}
