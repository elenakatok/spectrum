// Spectrum ledger — pure core (Slice 1). No firebase, no I/O — unit-testable.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §3, §5, §7 + the Slice 1 prompt.

import { valueOfHolding } from './synergy'
import { resolveAuction, type AuctionBid } from './auction/resolver'
import type { AuctionSettings } from './auction/settings'

export interface SynergyRow {
  region: string
  regionIndex?: number
  schedule: number
  values: number[] // value(1..8), index 0 = holding 1
}

/** Region letter from a license id like "C6" -> "C". */
export function regionOfLicenseId(id: string): string {
  return id.replace(/\d+$/, '')
}

/** Count of licenses held per region letter. */
export function holdingsByRegion(licenseIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const id of licenseIds) {
    const r = regionOfLicenseId(id)
    counts[r] = (counts[r] ?? 0) + 1
  }
  return counts
}

/**
 * Portfolio value = cash + Σ over regions of the synergy value of the count held.
 * Uses the precomputed value(1..8) row; for k>8 (defensive) falls back to the formula.
 * A region with no synergy row contributes 0 (never crashes).
 */
export function portfolioValueFor(cash: number, licenseIds: string[], synergyRows: SynergyRow[]): number {
  const counts = holdingsByRegion(licenseIds)
  const rowByRegion = new Map(synergyRows.map((r) => [r.region, r]))
  let licenseValue = 0
  for (const [region, k] of Object.entries(counts)) {
    if (k <= 0) continue
    const row = rowByRegion.get(region)
    if (!row) continue
    licenseValue += k <= row.values.length ? row.values[k - 1] : valueOfHolding(row.schedule, k)
  }
  return cash + licenseValue
}

// The vendored eBay resolver is consumed UNMODIFIED (see functions/src/auction/resolver.ts,
// copied byte-for-byte from games/ebay). Spectrum pins first-price sealed. `increment` and
// `startingPrice` are irrelevant for first-price (winner pays their own bid).
export const SPECTRUM_AUCTION_SETTINGS: AuctionSettings = {
  durationSeconds: 240,
  increment: 0,
  direction: 'ascending',
  format: 'sealed',
  closeType: 'hard',
  pricing: 'first',
  proxyBidding: false,
  revealAtClose: 'full',
}

export interface TeamBid {
  teamNumber: number
  amount: number
  atMs: number // server-receipt time; tie-break only
}

export const AUCTION_CUTOFF_MINUTES = 5 // fixed; no new auctions in the final 5 min (v3 §1)

/**
 * The cutoff rule (v3 §1; the legacy never implemented it). An auction may be created only
 * if it will END at or before `market close − cutoff`. Accept iff
 *   now + durationMin  <=  closesAt − cutoffMin
 * i.e. endsAt <= cutoff. Equality is accepted (boundary inclusive). All args in ms except
 * the minute durations. Pure — unit-tested at the exact boundary.
 */
export function auctionEndsBeforeCutoff(
  nowMs: number,
  durationMin: number,
  closesAtMs: number,
  cutoffMin: number = AUCTION_CUTOFF_MINUTES,
): boolean {
  const endsAt = nowMs + durationMin * 60_000
  const cutoff = closesAtMs - cutoffMin * 60_000
  return endsAt <= cutoff
}

/**
 * Determine the auction winner via the vendored eBay resolver (unmodified).
 *
 * The resolver has no reserve concept, so RESERVE is a Spectrum rule layered on top:
 * only bids `amount >= reserve` are eligible, applied by PRE-FILTERING before the
 * resolver. Consequences, all per spec:
 *   • at-reserve WINS (>= includes equality) — the legacy void-at-reserve bug inverted;
 *   • ties -> earliest bid (the resolver's own tie-break: max desc, then atMs asc);
 *   • first-price -> winner pays their own bid (resolver 'first' = winner.maxAmount);
 *   • no eligible bid -> no sale (resolver returns winnerBidderIndex null).
 * The resolver's vCommon / endowment / profit machinery is unused (Spectrum has no
 * common value); we pass vCommon 0 and empty endowments and read only winner + price.
 */
export function determineAuctionWinner(
  bids: TeamBid[],
  reserve: number,
): { winnerTeam: number | null; clearingPrice: number | null } {
  const eligible: AuctionBid[] = bids
    .filter((b) => b.amount >= reserve)
    .map((b) => ({ bidderIndex: b.teamNumber, maxAmount: b.amount, serverTimestampMs: b.atMs }))
  const res = resolveAuction(eligible, [], 0, SPECTRUM_AUCTION_SETTINGS, 0)
  return { winnerTeam: res.winnerBidderIndex, clearingPrice: res.clearingPrice }
}
