// Spectrum market-report CORE — Slice 6. PURE synergy × ownership math behind Reports 3 & 4.
//
// Extracted from the getMarketReport callable (instructorReads.ts) so the exact algorithm the
// callable runs is unit-testable without Firestore — the same split ledgerCore.ts uses. NO I/O.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md §13.2–§13.3 + the Slice 6 prompt (Elena's
// efficient-concentration framing, which OVERRIDES §13.3's "who won the block"). The efficient
// value per region is the value(8) argmax (=1550, the schedule-4 team) — the SAME benchmark
// efficientMarketValue() sums. Realized value sums each CURRENT holder's OWN value(count).

import { valueOfHolding, assignedSchedule, regionLetter, LICENSES_PER_REGION } from './synergy'

/** team_number -> (region_index -> license count). The current ownership tally. */
export type HoldingsMap = Map<number, Map<number, number>>

export interface RegionGain {
  region: string
  region_index: number
  /** value(8) argmax over all teams — the efficient-concentration ceiling for the region. */
  efficient_value: number
  /** Σ over current holders of that holder's OWN value(count) in the region. */
  realized_value: number
  /** efficient − realized: the gains from trade still on the table. */
  gap: number
  /** The two teams with the strongest synergy here (argmax + runner-up). NOT "winners". */
  top_synergy_teams: number[]
}

export interface TeamHoldingRow {
  region: string
  region_index: number
  count: number
  schedule: number
  /** valueOfHolding(schedule, count) — this team's own synergy applied to what it holds. */
  value: number
}

/**
 * Per-region gains-from-trade (Report 3), computed purely from the ownership tally + (N, M).
 * For each region i: efficient = max_g value(8); realized = Σ_{g holds k>0} value_g(k);
 * gap = efficient − realized; the two strongest-synergy teams are the value(8) argmax + runner-up.
 */
export function computeRegionGains(holdings: HoldingsMap, N: number, M: number): RegionGain[] {
  const out: RegionGain[] = []
  for (let i = 1; i <= M; i++) {
    const value8: { team_number: number; v: number }[] = []
    for (let g = 1; g <= N; g++) {
      value8.push({ team_number: g, v: valueOfHolding(assignedSchedule(g, i, M), LICENSES_PER_REGION) })
    }
    value8.sort((a, b) => b.v - a.v || a.team_number - b.team_number)
    const efficient_value = value8[0]?.v ?? 0

    let realized_value = 0
    for (let g = 1; g <= N; g++) {
      const count = holdings.get(g)?.get(i) ?? 0
      if (count > 0) realized_value += valueOfHolding(assignedSchedule(g, i, M), count)
    }
    out.push({
      region: regionLetter(i),
      region_index: i,
      efficient_value,
      realized_value,
      gap: efficient_value - realized_value,
      top_synergy_teams: value8.slice(0, 2).map((x) => x.team_number),
    })
  }
  return out
}

/**
 * A team's current holdings-with-value (Report 4), one row per region it holds (count > 0),
 * sorted by region. `value` is the team's OWN synergy applied to what it now holds.
 */
export function teamHoldingRows(holdings: HoldingsMap, teamNumber: number, M: number): TeamHoldingRow[] {
  const byRegion = holdings.get(teamNumber) ?? new Map<number, number>()
  return [...byRegion.entries()]
    .filter(([, count]) => count > 0)
    .map(([ri, count]) => {
      const schedule = assignedSchedule(teamNumber, ri, M)
      return { region: regionLetter(ri), region_index: ri, count, schedule, value: valueOfHolding(schedule, count) }
    })
    .sort((a, b) => a.region_index - b.region_index)
}
