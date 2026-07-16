import { type CSSProperties } from 'react'
import type { ReportTransaction } from '../api'
import { money, clock } from './shared'

// ── Live running table of trades (v3 §11–§13) — the instructor dashboard's Transaction Graph
// view pairs this with the graph. Columns: Time · Type · Buyer · Seller · Region · Units · Price ·
// Price/license, with the SAME true-unit-price rule as the post-game Report 2 (price is the LOT
// total; price/license = price ÷ quantity — a lot of 2 for $300 reads $150/license). The per-
// license figure comes straight from getMarketReport's server-computed `price_per_license`.
// INSTRUCTOR-ONLY, like everything getMarketReport serves — there is no student path to it.

const elapsed = (atMs: number | null, openedAt: number | null) =>
  atMs != null && openedAt != null ? clock(Math.max(0, atMs - openedAt)) : '—'

export default function LiveTransactionsTable({ transactions, openedAt }: {
  transactions: ReportTransaction[]
  openedAt: number | null
}) {
  // Most recent first — a live feed reads top-down as trades land.
  const txs = [...transactions].sort((a, b) => (b.at_ms ?? 0) - (a.at_ms ?? 0))
  const row = (t: ReportTransaction) => {
    const buyer = t.to_team != null ? `Team ${t.to_team}` : '—'
    const seller = t.from_team != null ? `Team ${t.from_team}` : '—'
    if (t.type === 'swap') {
      return {
        buyer, seller,
        region: `${t.quantity_x ?? '—'}×${t.region_x ?? '—'} ↔ ${t.quantity_y ?? '—'}×${t.region_y ?? '—'}`,
        units: null as number | null, price: null as number | null, unit: null as number | null,
      }
    }
    return { buyer, seller, region: `Region ${t.region ?? '—'}`, units: t.quantity, price: t.price, unit: t.price_per_license }
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: '46vh', border: '1px solid #ddd', borderRadius: 6 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', width: '100%' }} data-testid="live-transactions-table">
        <thead>
          <tr>
            <th style={thL}>Time</th><th style={thL}>Type</th><th style={thL}>Buyer</th><th style={thL}>Seller</th>
            <th style={thL}>Region</th><th style={th}>Units</th><th style={th}>Price</th><th style={th}>Price / license</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t, i) => {
            const r = row(t)
            return (
              <tr key={t.transaction_id} data-testid={`live-tx-row-${i}`}>
                <td style={tdL}>{elapsed(t.at_ms, openedAt)}</td>
                <td style={{ ...tdL, textTransform: 'capitalize' }}>{t.type}</td>
                <td style={tdL}>{r.buyer}</td>
                <td style={tdL}>{r.seller}</td>
                <td style={tdL}>{r.region}</td>
                <td style={td}>{r.units ?? '—'}</td>
                <td style={td}>{r.price != null ? money(r.price) : '—'}</td>
                <td style={td}>{r.unit != null ? money(r.unit) : '—'}</td>
              </tr>
            )
          })}
          {txs.length === 0 && <tr><td style={tdL} colSpan={8}>No trades yet — the table fills as trades land.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', background: '#f6f8fa', textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }
const thL: CSSProperties = { ...th, textAlign: 'left' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdL: CSSProperties = { ...td, textAlign: 'left', fontVariantNumeric: 'normal' }
