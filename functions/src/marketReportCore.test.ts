import { describe, it, expect } from 'vitest'
import { computeRegionGains, teamHoldingRows, type HoldingsMap } from './marketReportCore'

// ═══════════════════════════════════════════════════════════════════════════════
// Slice 6 named assertion (LEG 2 — Report 3 correctness). Deterministic proof that,
// for a seeded market, each region's realized value = Σ holders' OWN value(count),
// the efficient value is the value(8) argmax (=1550, the schedule-4 team), and
// gap = efficient − realized. Proven on a CONSOLIDATED region (realized AT efficient)
// AND a SPLIT region (realized well below efficient) — Elena's two required cases.
// The emulator/prod smoke prove the Firestore wiring; this proves the math.
// ═══════════════════════════════════════════════════════════════════════════════

const N = 14, M = 7

// Ownership tally (team -> region_index -> count).
//   Region A (1): team 4 holds all 8 → consolidated on its OWN schedule-4 synergy (=efficient).
//   Region B (2): 2/2/2/2 across teams 1,2,5,6 → split several ways, realized well below efficient.
//   The schedule-4 team for B (team 3) holds NONE — the efficient concentration never formed.
function seededScatter(): HoldingsMap {
  const h: HoldingsMap = new Map()
  const set = (team: number, region: number, count: number) => {
    const r = h.get(team) ?? new Map<number, number>()
    r.set(region, count)
    h.set(team, r)
  }
  set(4, 1, 8)                         // consolidated
  set(1, 2, 2); set(2, 2, 2); set(5, 2, 2); set(6, 2, 2)  // split
  return h
}

describe('Leg 2 — per-region gains on a seeded scattered market (N=14, M=7)', () => {
  const regions = computeRegionGains(seededScatter(), N, M)
  const byLetter = new Map(regions.map((r) => [r.region, r]))

  it('every region efficient value is the value(8) argmax = 1550', () => {
    for (const r of regions) expect(r.efficient_value).toBe(1550)
  })

  it('CONSOLIDATED region A: team 4 holds all 8 → realized = efficient, gap 0', () => {
    const a = byLetter.get('A')!
    expect(a.realized_value).toBe(1550)          // team 4, schedule 4, value(8) = 1550
    expect(a.gap).toBe(0)
    // The two strongest-synergy teams here: the schedule-4 team (1550) then the 4→14 swap team (1465).
    expect(a.top_synergy_teams).toEqual([4, 11])
  })

  it('SPLIT region B: 2+2+2+2 across teams 1/2/5/6 → realized well below efficient', () => {
    const b = byLetter.get('B')!
    // value(2): team1 sched2=225, team2 sched3=230, team5 sched6=230, team6 sched7=240.
    expect(b.realized_value).toBe(225 + 230 + 230 + 240) // 925
    expect(b.gap).toBe(1550 - 925)                        // 625
    expect(b.realized_value).toBeLessThan(b.efficient_value)
    expect(b.top_synergy_teams).toEqual([3, 10])          // schedule-4 team 3 holds NONE
  })

  it('untouched regions: no holders → realized 0, gap = full efficient', () => {
    for (const r of regions) {
      if (r.region === 'A' || r.region === 'B') continue
      expect(r.realized_value).toBe(0)
      expect(r.gap).toBe(1550)
    }
  })

  it('realized = Σ holders OWN value(count) — never a foreign schedule', () => {
    // Re-derive region B realized from each holder's own schedule independently of the SUT.
    const b = byLetter.get('B')!
    const parts = [225, 230, 230, 240] // the four holders' own value(2)
    expect(b.realized_value).toBe(parts.reduce((s, x) => s + x, 0))
  })
})

describe('Leg 2b — teamHoldingRows applies the team OWN synergy (Report 4)', () => {
  const h = seededScatter()
  it('team 4 in region A: 8 licenses, schedule 4, value 1550', () => {
    expect(teamHoldingRows(h, 4, M)).toEqual([{ region: 'A', region_index: 1, count: 8, schedule: 4, value: 1550 }])
  })
  it('team 1 in region B: 2 licenses, schedule 2, value 225', () => {
    expect(teamHoldingRows(h, 1, M)).toEqual([{ region: 'B', region_index: 2, count: 2, schedule: 2, value: 225 }])
  })
  it('a team holding nothing yields no rows', () => {
    expect(teamHoldingRows(h, 9, M)).toEqual([])
  })
})
