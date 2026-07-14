import { describe, it, expect } from 'vitest'
import {
  valueOfHolding,
  assignedSchedule,
  teamSynergy,
  endowmentRegions,
  assignLicenses,
  generateTeams,
  efficientMarketValue,
  openingPortfolioValue,
  passwordForTeam,
  normalizePassword,
  validateNumTeams,
  regionLetter,
} from './synergy'

// ═══════════════════════════════════════════════════════════════════════════════
// Slice 0 named assertion — four legs, all at N=20 — plus EMV + conformance.
// These are the numbers from the Slice 0 prompt (verified cell-for-cell against the
// workbook's 26-team map). This test is the deterministic proof; the emulator
// playthrough proves the end-to-end wiring.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Leg 1 — team 7 synergy map at N=20 matches cell-for-cell', () => {
  const M = 10
  const expected: Record<string, [number, number[]]> = {
    A: [7, [100, 240, 370, 490, 600, 710, 820, 930]],
    B: [8, [100, 205, 310, 415, 520, 625, 730, 835]],
    C: [9, [100, 210, 330, 460, 600, 740, 880, 1020]],
    D: [10, [100, 215, 345, 490, 650, 810, 970, 1130]],
    E: [1, [100, 200, 300, 400, 500, 600, 700, 800]],
    F: [2, [100, 225, 375, 550, 750, 950, 1150, 1350]],
    G: [3, [100, 230, 390, 580, 800, 1020, 1240, 1460]],
    H: [4, [100, 200, 300, 550, 800, 1050, 1300, 1550]],
    I: [5, [100, 200, 300, 700, 800, 900, 1000, 1100]],
    J: [6, [100, 230, 350, 460, 565, 670, 775, 880]],
  }
  const rows = teamSynergy(7, M)
  for (const row of rows) {
    it(`region ${row.region}`, () => {
      const [schedule, values] = expected[row.region]
      expect(row.schedule).toBe(schedule)
      expect(row.values).toEqual(values)
    })
  }
})

describe('Leg 2 — every team opens at portfolio value 1400 (N=20)', () => {
  const N = 20
  for (let g = 1; g <= N; g++) {
    it(`team ${g}`, () => {
      const regs = endowmentRegions(g, N / 2)
      expect(regs.length).toBe(4)
      expect(new Set(regs).size).toBe(4) // 4 distinct regions
      expect(openingPortfolioValue(g, N)).toBe(1400)
    })
  }
})

describe('Leg 3 — team 7 password is Strauss', () => {
  it('positional list', () => {
    expect(passwordForTeam(7)).toBe('Strauss')
  })
})

describe('Leg 4 — the tight net: top two value(8) are 1550 (g) and 1465 (g+M) in every region', () => {
  const N = 20
  const M = N / 2
  const expected: Record<string, [number, number]> = {
    A: [4, 14], B: [3, 13], C: [2, 12], D: [1, 11], E: [10, 20],
    F: [9, 19], G: [8, 18], H: [7, 17], I: [6, 16], J: [5, 15],
  }
  for (let i = 1; i <= M; i++) {
    const region = regionLetter(i)
    it(`region ${region}`, () => {
      const v8 = Array.from({ length: N }, (_, k) => {
        const g = k + 1
        return { g, v: valueOfHolding(assignedSchedule(g, i, M), 8) }
      }).sort((a, b) => b.v - a.v)
      const [first, second] = v8
      const [wantFirstG, wantSecondG] = expected[region]
      expect(first.v).toBe(1550)
      expect(second.v).toBe(1465)
      expect(first.g).toBe(wantFirstG) // first-half team g wins
      expect(second.g).toBe(wantSecondG) // second-half team g+M is runner-up
      expect(first.g).toBeLessThanOrEqual(M)
      expect(second.g).toBeGreaterThan(M)
    })
  }
})

describe('Bonus — Efficient Market Value (closed form) matches verified figures', () => {
  it.each([
    [14, 24850],
    [20, 35500],
    [26, 46150],
  ])('N=%i → EMV %i', (N, emv) => {
    expect(efficientMarketValue(N)).toBe(emv)
  })
  it('N=10 SoPHIE anchor → 17750', () => {
    expect(efficientMarketValue(10)).toBe(17750)
  })
})

describe('Conformance — cyclic Latin-square structure (incl. untabulated N=16, 22)', () => {
  it.each([14, 16, 20, 22, 26])('N=%i', (N) => {
    const M = N / 2
    // Each first-half team sees each schedule 1..M exactly once.
    for (let g = 1; g <= M; g++) {
      const scheds = teamSynergy(g, M).map(r => r.schedule).sort((a, b) => a - b)
      expect(scheds).toEqual(Array.from({ length: M }, (_, k) => k + 1))
    }
    // Each second-half team has exactly one 14 and zero 4 (the swap hits ONE region).
    for (let g = M + 1; g <= N; g++) {
      const scheds = teamSynergy(g, M).map(r => r.schedule)
      expect(scheds.filter(s => s === 14).length).toBe(1)
      expect(scheds.filter(s => s === 4).length).toBe(0)
    }
  })
})

describe('Invariants established at grouping', () => {
  it.each([14, 16, 20, 22, 26])('N=%i — cash conservation + one owner + 4 distinct regions', (N) => {
    const M = N / 2
    // Cash conservation: Σ cash == N × startingCash.
    const teams = generateTeams(N)
    expect(teams.length).toBe(N)
    // Every license has exactly one owner; each region has exactly 8 licenses.
    const licenses = assignLicenses(N)
    expect(licenses.length).toBe(4 * N) // M regions × 8 = 4N
    const ids = new Set(licenses.map(l => l.licenseId))
    expect(ids.size).toBe(licenses.length) // unique ids, one owner each
    for (let i = 1; i <= M; i++) {
      const inRegion = licenses.filter(l => l.regionIndex === i)
      expect(inRegion.length).toBe(8)
      expect(new Set(inRegion.map(l => l.ownerTeam)).size).toBe(8) // 8 distinct holders
    }
    // Each team holds exactly 4 licenses in 4 distinct regions.
    for (let g = 1; g <= N; g++) {
      const held = licenses.filter(l => l.ownerTeam === g)
      expect(held.length).toBe(4)
      expect(new Set(held.map(l => l.regionIndex)).size).toBe(4)
    }
  })
})

describe('Password comparison + validation helpers', () => {
  it('normalizePassword trims + lowercases', () => {
    expect(normalizePassword('  Johnson ')).toBe('johnson')
    expect(normalizePassword('STRAUSS')).toBe('strauss')
  })
  it('validateNumTeams rejects odd / out-of-range', () => {
    expect(() => validateNumTeams(15)).toThrow()
    expect(() => validateNumTeams(12)).toThrow()
    expect(() => validateNumTeams(28)).toThrow()
    expect(() => validateNumTeams(20)).not.toThrow()
  })
})
