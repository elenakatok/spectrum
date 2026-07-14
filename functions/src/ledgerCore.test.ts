import { describe, it, expect } from 'vitest'
import {
  regionOfLicenseId,
  holdingsByRegion,
  portfolioValueFor,
  determineAuctionWinner,
  auctionEndsBeforeCutoff,
  type SynergyRow,
  type TeamBid,
} from './ledgerCore'

describe('license id helpers', () => {
  it('regionOfLicenseId strips the trailing number', () => {
    expect(regionOfLicenseId('C6')).toBe('C')
    expect(regionOfLicenseId('A12')).toBe('A')
  })
  it('holdingsByRegion counts per region', () => {
    expect(holdingsByRegion(['C1', 'C2', 'D5'])).toEqual({ C: 2, D: 1 })
    expect(holdingsByRegion([])).toEqual({})
  })
})

describe('portfolioValueFor', () => {
  // Real team-7 rows (from Slice 0): region A schedule 7, region H schedule 4.
  const rows: SynergyRow[] = [
    { region: 'A', schedule: 7, values: [100, 240, 370, 490, 600, 710, 820, 930] },
    { region: 'H', schedule: 4, values: [100, 200, 300, 550, 800, 1050, 1300, 1550] },
  ]
  it('cash + Σ region value(count)', () => {
    // 1 in A (100) + 2 in H (200) + 1000 cash = 1300
    expect(portfolioValueFor(1000, ['A1', 'H1', 'H2'], rows)).toBe(1300)
  })
  it('concentration beats spreading (superadditive)', () => {
    // 8 in H = 1550 vs eight singletons across flat regions = 800
    expect(portfolioValueFor(0, ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'], rows)).toBe(1550)
  })
  it('a region with no synergy row contributes 0 (never crashes)', () => {
    expect(portfolioValueFor(500, ['Z1', 'Z2'], rows)).toBe(500)
  })
  it('empty holdings = just cash', () => {
    expect(portfolioValueFor(1000, [], rows)).toBe(1000)
  })
})

describe('determineAuctionWinner — vendored resolver wrapped with reserve', () => {
  const bid = (teamNumber: number, amount: number, atMs: number): TeamBid => ({ teamNumber, amount, atMs })

  it('highest bid wins; first-price → winner pays their own bid', () => {
    expect(determineAuctionWinner([bid(1, 300, 10), bid(2, 500, 20), bid(3, 400, 30)], 0))
      .toEqual({ winnerTeam: 2, clearingPrice: 500 })
  })
  it('at-reserve WINS (>= reserve) — the inverted legacy bug', () => {
    expect(determineAuctionWinner([bid(1, 250, 10)], 250)).toEqual({ winnerTeam: 1, clearingPrice: 250 })
  })
  it('below reserve → no sale', () => {
    expect(determineAuctionWinner([bid(1, 249, 10), bid(2, 200, 20)], 250))
      .toEqual({ winnerTeam: null, clearingPrice: null })
  })
  it('only bids >= reserve are eligible; highest eligible wins', () => {
    // team 1 bids 600 (>=500), team 2 bids 400 (<500 → excluded)
    expect(determineAuctionWinner([bid(1, 600, 10), bid(2, 400, 20)], 500))
      .toEqual({ winnerTeam: 1, clearingPrice: 600 })
  })
  it('ties → earliest bid wins (by atMs)', () => {
    expect(determineAuctionWinner([bid(3, 500, 40), bid(1, 500, 10), bid(2, 500, 25)], 0))
      .toEqual({ winnerTeam: 1, clearingPrice: 500 })
  })
  it('no bids at all → no sale', () => {
    expect(determineAuctionWinner([], 100)).toEqual({ winnerTeam: null, clearingPrice: null })
  })
})

describe('auctionEndsBeforeCutoff — the cutoff boundary, exact (4-min auction, 5-min cutoff)', () => {
  const T = 10_000_000        // market closes at T (ms)
  const DURATION = 4          // minutes
  const CUTOFF = 5            // minutes
  // cutoff instant = T − 5:00 = T − 300000. An auction created at `now` ends at now+240000.
  it('created at T−9:01 → accepted (ends at T−5:01, before cutoff)', () => {
    expect(auctionEndsBeforeCutoff(T - 541_000, DURATION, T, CUTOFF)).toBe(true)
  })
  it('created at T−9:00 exactly → accepted (ends exactly at the cutoff; boundary inclusive)', () => {
    expect(auctionEndsBeforeCutoff(T - 540_000, DURATION, T, CUTOFF)).toBe(true)
  })
  it('created at T−8:59 → rejected (ends at T−4:59, inside the final 5 min)', () => {
    expect(auctionEndsBeforeCutoff(T - 539_000, DURATION, T, CUTOFF)).toBe(false)
  })
  it('default cutoff is 5 minutes', () => {
    expect(auctionEndsBeforeCutoff(T - 540_000, DURATION, T)).toBe(true)
    expect(auctionEndsBeforeCutoff(T - 539_000, DURATION, T)).toBe(false)
  })
})
