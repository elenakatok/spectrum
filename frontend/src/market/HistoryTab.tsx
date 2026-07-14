import { type CSSProperties, useEffect, useState } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { getTeamHistory, type HistoryRow } from '../api'
import { money, clock } from './shared'

// ── History tab (v3 §11.5) — the team's OWN transactions. Prices shown (you were a party).
// Type · Buyer · Seller · Region · Units · Price · Elapsed. Served via getTeamHistory, whose
// query IS the privacy boundary — only rows where your team is a party come back.

export default function HistoryTab({ myTeam, openedAt }: { myTeam: number | null; openedAt: number | null }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      getTeamHistory()
        .then((r) => { if (alive) { setRows(r.rows); setErr(null) } })
        .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : 'Could not load history.') })
    load()
    const id = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (err) return <p style={{ color: '#c00' }}>{err}</p>
  if (!rows) return <p style={{ color: colors.textSecondary }}>Loading history…</p>
  if (rows.length === 0) return (
    <div data-testid="history-tab">
      <h2 style={{ fontSize: '1.1rem', marginTop: 0 }}>History</h2>
      <p style={{ color: colors.textSecondary }}>No trades yet. Your completed deals, swaps, and auctions will appear here.</p>
    </div>
  )

  const elapsed = (at: number | null) =>
    at == null || openedAt == null ? '—' : clock(at - openedAt)

  // Deal/auction: seller = from_team, buyer = to_team. Swap: two-sided, no buyer/seller, no price.
  const label = (t: string) => (t === 'auction' ? 'Auction' : t === 'swap' ? 'Swap' : 'Deal')
  const regionUnits = (r: HistoryRow) =>
    r.type === 'swap'
      ? `${r.region_x}×${r.quantity_x} ↔ ${r.region_y}×${r.quantity_y}`
      : `${r.region}`

  return (
    <div data-testid="history-tab">
      <h2 style={{ fontSize: '1.1rem', marginTop: 0, marginBottom: spacing.gapSm }}>History</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.88rem', minWidth: 560 }}>
          <thead>
            <tr>
              {['Type', 'Seller', 'Buyer', 'Region', 'Units', 'Price', 'Elapsed'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.transaction_id}>
                <td style={td}>{label(r.type)}</td>
                <td style={td}>{r.type === 'swap' ? `T${r.from_team}` : teamCell(r.from_team, myTeam)}</td>
                <td style={td}>{r.type === 'swap' ? `T${r.to_team}` : teamCell(r.to_team, myTeam)}</td>
                <td style={td}>{regionUnits(r)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.type === 'swap' ? '—' : r.quantity ?? '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.type === 'swap' ? '—' : money(r.price)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{elapsed(r.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const teamCell = (team: number | null, myTeam: number | null) =>
  team == null ? '—' : team === myTeam ? `T${team} (you)` : `T${team}`

const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.35rem 0.6rem', background: '#f6f8fa', textAlign: 'left' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.35rem 0.6rem', textAlign: 'left' }
