// Shared types + helpers for the Spectrum market room (Slice 3).

export type LicenseDoc = {
  license_id: string
  region: string
  region_index?: number
  owner_team: number
  under_auction: string | null
}

export type RegionSchedule = {
  region: string
  regionIndex?: number
  schedule: number
  values: number[] // value(1..8) for this team in this region
}

export const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')

/** Value of holding `count` licenses in a region on this team's schedule (superadditive). */
export function regionValue(row: RegionSchedule | undefined, count: number): number {
  if (!row || count <= 0) return 0
  return row.values[Math.min(count, row.values.length) - 1] ?? 0
}

/** mm:ss for a millisecond duration (clamped at 0). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
