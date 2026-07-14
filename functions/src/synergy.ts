// Spectrum synergy + endowment generator — Slice 0.
//
// AUTHORITY: Spectrum_Game_Specification_v3.md (§3, §4) plus the Slice 0 prompt,
// which carries the VERIFIED schedule table, value formula, and assignment rule
// (validated cell-for-cell against the workbook's 26-team map: 338/338 cells).
//
// Do NOT read Spectrum_Synergy_Algorithm.md — its formula is off by one. This
// module is the single source of truth for the numbers.

/**
 * Fourteen synergy schedules, each a quadruple (two, three, four, n).
 * Schedules 11/12/13 are INTENTIONAL exact duplicates of 2/8/9 (they only
 * surface at M >= 11, i.e. N >= 22). Do not "fix" them.
 * Schedule 4 is the strong one (value(8) = 1550); schedule 14 the downgrade
 * (value(8) = 1465) used by the 4->14 second-half swap.
 */
export const SCHEDULES: Record<number, [number, number, number, number]> = {
  1: [0, 0, 0, 0],
  2: [25, 50, 75, 100],
  3: [30, 60, 90, 120],
  4: [0, 0, 150, 150], // value(8) = 1550
  5: [0, 0, 300, 0],
  6: [30, 20, 10, 5],
  7: [40, 30, 20, 10],
  8: [5, 5, 5, 5],
  9: [10, 20, 30, 40],
  10: [15, 30, 45, 60],
  11: [25, 50, 75, 100], // duplicate of 2 (deliberate)
  12: [5, 5, 5, 5], // duplicate of 8 (deliberate)
  13: [10, 20, 30, 40], // duplicate of 9 (deliberate)
  14: [0, 0, 125, 135], // value(8) = 1465
};

/**
 * Ordered, hardcoded team-password list (v3 §2.2). Team n gets the nth password.
 * Not generated, not shuffled. Supports N up to 26.
 */
export const TEAM_PASSWORDS: readonly string[] = [
  "Johnson", "Horrigan", "Robinson", "Cohen", "Stern", "Nusbaum", "Strauss",
  "Darrow", "Kravis", "Roberts", "Beck", "Gleacher", "Waters", "Wasserstein",
  "Forstmann", "Little", "Boise", "Maher", "Finn", "Pritzker", "Hugel", "Davis",
  "Atkins", "Rosen", "Rohatyn", "Bagley",
];

export const MIN_TEAMS = 14;
export const MAX_TEAMS = 26;
export const LICENSES_PER_REGION = 8;
export const ENDOWMENT_SIZE = 4;
export const DEFAULT_STARTING_CASH = 1000;
export const DEFAULT_MARKET_DURATION_MINUTES = 90;
export const DEFAULT_AUCTION_DURATION_MINUTES = 4; // SoPHIE production value (240s)

/** Password for team n (1-indexed). */
export function passwordForTeam(teamNumber: number): string {
  const pw = TEAM_PASSWORDS[teamNumber - 1];
  if (!pw) throw new Error(`No password for team ${teamNumber} (max ${MAX_TEAMS})`);
  return pw;
}

/** Normalize a typed password for comparison: trim + lowercase. */
export function normalizePassword(input: string): string {
  return (input ?? "").trim().toLowerCase();
}

/** Region index (1-based) -> letter. 1 -> "A", 2 -> "B", ... */
export function regionLetter(i: number): string {
  return String.fromCharCode("A".charCodeAt(0) + (i - 1));
}

/**
 * Value of holding k licenses in a region on the given schedule.
 * value(1)=100; value(2)=200+two; value(3)=300+two+three;
 * value(4)=400+two+three+four; value(k>4)=100k+two+three+four+(k-4)*n.
 */
export function valueOfHolding(schedule: number, k: number): number {
  const s = SCHEDULES[schedule];
  if (!s) throw new Error(`Unknown schedule ${schedule}`);
  const [two, three, four, n] = s;
  if (k <= 0) return 0;
  if (k === 1) return 100;
  if (k === 2) return 200 + two;
  if (k === 3) return 300 + two + three;
  if (k === 4) return 400 + two + three + four;
  return 100 * k + two + three + four + (k - 4) * n;
}

/**
 * Which schedule team g holds in region i, given M regions. Cyclic Latin square
 * with a -2 offset, plus the single-region 4->14 swap for the second half.
 *
 *   s = ((i + g - 2) mod M) + 1
 *   if g > M and s === 4, then s = 14   (ONLY that one region, not the row)
 */
export function assignedSchedule(g: number, i: number, M: number): number {
  let s = ((i + g - 2) % M) + 1;
  if (g > M && s === 4) s = 14;
  return s;
}

export interface RegionSchedule {
  region: string; // letter
  regionIndex: number; // 1-based
  schedule: number;
  /** value(1..8), index 0 = holding 1. */
  values: number[];
}

/** Full synergy map for one team: one RegionSchedule per region. */
export function teamSynergy(g: number, M: number): RegionSchedule[] {
  const rows: RegionSchedule[] = [];
  for (let i = 1; i <= M; i++) {
    const schedule = assignedSchedule(g, i, M);
    const values: number[] = [];
    for (let k = 1; k <= LICENSES_PER_REGION; k++) values.push(valueOfHolding(schedule, k));
    rows.push({ region: regionLetter(i), regionIndex: i, schedule, values });
  }
  return rows;
}

export interface TeamGeneration {
  teamNumber: number; // 1-based
  password: string;
  synergy: RegionSchedule[]; // M rows
  /** 1-based region indices this team is endowed with (4 distinct). */
  endowmentRegions: number[];
}

/**
 * Endowment: team g gets one license from each of regions g, g+1, g+2, g+3 (mod M).
 * 1-based, wrapping. Yields 4 distinct regions => opening license value 400.
 */
export function endowmentRegions(g: number, M: number): number[] {
  const regs: number[] = [];
  for (let d = 0; d < ENDOWMENT_SIZE; d++) {
    regs.push(((g - 1 + d) % M) + 1);
  }
  return regs;
}

/** Validate an instructor-chosen N. Throws on any violation. */
export function validateNumTeams(N: number): void {
  if (!Number.isInteger(N)) throw new Error(`numTeams must be an integer, got ${N}`);
  if (N % 2 !== 0) throw new Error(`numTeams must be even, got ${N}`);
  if (N < MIN_TEAMS || N > MAX_TEAMS) {
    throw new Error(`numTeams must be between ${MIN_TEAMS} and ${MAX_TEAMS}, got ${N}`);
  }
}

/**
 * Generate the full team model for N teams: passwords, synergy maps, endowments.
 * Pure — no I/O. M = N/2.
 */
export function generateTeams(N: number): TeamGeneration[] {
  validateNumTeams(N);
  const M = N / 2;
  const teams: TeamGeneration[] = [];
  for (let g = 1; g <= N; g++) {
    teams.push({
      teamNumber: g,
      password: passwordForTeam(g),
      synergy: teamSynergy(g, M),
      endowmentRegions: endowmentRegions(g, M),
    });
  }
  return teams;
}

/** License id for a region + copy index, e.g. region 3 -> "C1".."C8". */
export function licenseId(regionIndex: number, copy: number): string {
  return `${regionLetter(regionIndex)}${copy}`;
}

export interface LicenseAssignment {
  licenseId: string;
  regionIndex: number;
  region: string;
  ownerTeam: number; // 1-based
}

/**
 * Deterministic license -> owner assignment implied by the endowment rotation.
 * Region i's 8 licenses land on the 8 distinct teams g for which i is in
 * endowmentRegions(g, M). Copies are numbered 1..8 in ascending team order.
 */
export function assignLicenses(N: number): LicenseAssignment[] {
  const M = N / 2;
  const out: LicenseAssignment[] = [];
  for (let i = 1; i <= M; i++) {
    const owners: number[] = [];
    for (let g = 1; g <= N; g++) {
      if (endowmentRegions(g, M).includes(i)) owners.push(g);
    }
    // Each region has exactly 8 owners by construction (M regions * 8 = 4N).
    owners.forEach((g, idx) => {
      out.push({
        licenseId: licenseId(i, idx + 1),
        regionIndex: i,
        region: regionLetter(i),
        ownerTeam: g,
      });
    });
  }
  return out;
}

/**
 * Efficient Market Value (v3 §13.2): for each region, the max value(8) over all
 * teams, summed, plus N * startingCash. Closed form, O(M).
 */
export function efficientMarketValue(N: number, startingCash = DEFAULT_STARTING_CASH): number {
  const M = N / 2;
  let licenses = 0;
  for (let i = 1; i <= M; i++) {
    let best = 0;
    for (let g = 1; g <= N; g++) {
      best = Math.max(best, valueOfHolding(assignedSchedule(g, i, M), LICENSES_PER_REGION));
    }
    licenses += best;
  }
  return licenses + N * startingCash;
}

/** Opening portfolio value of a team: sum of value(1) over its 4 endowed regions + cash. */
export function openingPortfolioValue(g: number, N: number, startingCash = DEFAULT_STARTING_CASH): number {
  const M = N / 2;
  let licenseValue = 0;
  for (const i of endowmentRegions(g, M)) {
    licenseValue += valueOfHolding(assignedSchedule(g, i, M), 1);
  }
  return licenseValue + startingCash;
}
