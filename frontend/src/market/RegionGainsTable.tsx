import { type CSSProperties } from 'react'
import type { RegionGains } from '../api'
import { money } from './shared'

// ── Per-region gains-from-trade table (v3 §13) — shared by the POST-GAME Report 3 and the
// LIVE instructor dashboard view. Pure presentation over getMarketReport.regions (efficient =
// value(8) argmax; realized = Σ current holders' own value(count); gap = efficient − realized).
// Sorted by gap descending — the regions furthest from efficient concentration surface first.
// The caller owns the testids so the two mount points stay independently addressable.

export default function RegionGainsTable({ regions, tableTestid, rowTestid }: {
  regions: RegionGains[]
  tableTestid: string
  rowTestid: (region: string) => string
}) {
  const rows = [...regions].sort((a, b) => b.gap - a.gap)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', width: '100%', maxWidth: 760 }} data-testid={tableTestid}>
        <thead>
          <tr>
            <th style={thL}>Region</th><th style={th}>Efficient value</th><th style={th}>Realized value</th>
            <th style={th}>Gap</th><th style={thL}>Strongest synergy here</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.region} data-testid={rowTestid(r.region)}>
              <td style={{ ...tdL, fontWeight: 600 }}>Region {r.region}</td>
              <td style={td}>{money(r.efficient_value)}</td>
              <td style={td}>{money(r.realized_value)}</td>
              <td style={{ ...td, fontWeight: 700, color: r.gap > 0 ? '#b3261e' : '#137333' }}>{money(r.gap)}</td>
              <td style={tdL}>{r.top_synergy_teams.map((n) => `Team ${n}`).join(' · ')}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td style={tdL} colSpan={5}>No regions yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', background: '#f6f8fa', textAlign: 'right', whiteSpace: 'nowrap' }
const thL: CSSProperties = { ...th, textAlign: 'left' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdL: CSSProperties = { ...td, textAlign: 'left', fontVariantNumeric: 'normal' }
