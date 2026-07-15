import { useMemo } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import type { GraphPoint } from '../api'
import { money } from './shared'

// ── Transaction graph (v3 §13.1) — INSTRUCTOR ONLY, BY CONSTRUCTION. ──────────────────
// Every settled priced transaction as one mark: X = minutes since the market opened, Y =
// price PER LICENSE, colour = region, ○ = deal, △ = auction. Swaps carry no price, so they
// sit on a price-less strip beneath the axis (◇). This is the one surface that plots prices
// across ALL teams — there is deliberately NO student path to getTransactionGraph in the
// DOM, the API, or RTDB; the privacy walk asserts that a student session never sees it.

// A fixed, colour-blind-mindful region palette (region → colour), assigned in sorted order.
const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22']

const W = 720, H = 380
const M = { top: 20, right: 16, bottom: 92, left: 64 } // bottom leaves room for the swap strip + axis
const PLOT_W = W - M.left - M.right
const PLOT_H = H - M.top - M.bottom
const STRIP_H = 26 // the price-less swap band, just below the X axis

export default function TransactionGraph({
  points, openedAt, nowMs,
}: { points: GraphPoint[]; openedAt: number | null; nowMs: number }) {
  const { priced, swaps, regions, colourOf, maxMin, maxPrice } = useMemo(() => {
    const withElapsed = points
      .filter((p) => p.at_ms != null && openedAt != null)
      .map((p) => ({ ...p, min: (p.at_ms! - openedAt!) / 60000 }))
    const priced = withElapsed.filter((p) => p.price_per_license != null)
    const swaps = withElapsed.filter((p) => p.type === 'swap')
    const regions = [...new Set(points.map((p) => p.region).filter((r): r is string => !!r))].sort((a, b) => a.localeCompare(b))
    const colourOf = (r: string | null) => (r == null ? '#999' : PALETTE[regions.indexOf(r) % PALETTE.length])
    const nowMin = openedAt != null ? Math.max(0, (nowMs - openedAt) / 60000) : 0
    const maxMin = Math.max(1, nowMin, ...withElapsed.map((p) => p.min))
    const maxPrice = Math.max(100, ...priced.map((p) => p.price_per_license!)) * 1.08
    return { priced, swaps, regions, colourOf, maxMin, maxPrice }
  }, [points, openedAt, nowMs])

  const x = (min: number) => M.left + (min / maxMin) * PLOT_W
  const y = (price: number) => M.top + PLOT_H - (price / maxPrice) * PLOT_H
  const stripY = M.top + PLOT_H + 30 + STRIP_H / 2

  // Y gridlines / ticks at 5 even steps; X ticks every ~1/6 of the window.
  const yTicks = Array.from({ length: 6 }, (_, i) => (maxPrice / 5) * i)
  const xTicks = Array.from({ length: 7 }, (_, i) => (maxMin / 6) * i)

  return (
    <section data-testid="transaction-graph">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.gapSm, flexWrap: 'wrap', gap: spacing.gapSm }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Transaction graph</h2>
        <span style={{ fontSize: '0.8rem', color: colors.textSecondary }}>Instructor only · price per license over time</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H} role="img" aria-label="Transaction price per license over time" style={{ maxWidth: '100%', height: 'auto' }}>
          {/* Y grid + ticks (price per license) */}
          {yTicks.map((t, i) => (
            <g key={`y${i}`}>
              <line x1={M.left} x2={M.left + PLOT_W} y1={y(t)} y2={y(t)} stroke="#eceff1" />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#78909c">{money(t)}</text>
            </g>
          ))}
          {/* X ticks (minutes) */}
          {xTicks.map((t, i) => (
            <g key={`x${i}`}>
              <line x1={x(t)} x2={x(t)} y1={M.top} y2={M.top + PLOT_H} stroke="#f4f6f7" />
              <text x={x(t)} y={M.top + PLOT_H + 16} textAnchor="middle" fontSize="10" fill="#78909c">{Math.round(t)}m</text>
            </g>
          ))}
          {/* Axes */}
          <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PLOT_H} stroke="#90a4ae" />
          <line x1={M.left} x2={M.left + PLOT_W} y1={M.top + PLOT_H} y2={M.top + PLOT_H} stroke="#90a4ae" />
          <text x={M.left + PLOT_W / 2} y={M.top + PLOT_H + 34} textAnchor="middle" fontSize="11" fill="#546e7a">Minutes since market opened</text>
          <text transform={`translate(16 ${M.top + PLOT_H / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fill="#546e7a">Price per license</text>

          {/* Priced marks: ○ deal, △ auction */}
          {priced.map((p, i) => {
            const cx = x(p.min), cy = y(p.price_per_license!), c = colourOf(p.region)
            return p.type === 'auction'
              ? <polygon key={i} points={`${cx},${cy - 5} ${cx - 5},${cy + 4} ${cx + 5},${cy + 4}`} fill={c} fillOpacity={0.8} stroke={c} data-testid="graph-auction" />
              : <circle key={i} cx={cx} cy={cy} r={4.5} fill={c} fillOpacity={0.75} stroke={c} data-testid="graph-deal" />
          })}

          {/* Swap strip (price-less): ◇ at the transaction time */}
          <text x={M.left - 8} y={stripY + 4} textAnchor="end" fontSize="10" fill="#78909c">swaps</text>
          <line x1={M.left} x2={M.left + PLOT_W} y1={stripY} y2={stripY} stroke="#eceff1" />
          {swaps.map((p, i) => {
            const cx = x(p.min), c = colourOf(p.region)
            return <rect key={i} x={cx - 4} y={stripY - 4} width={8} height={8} transform={`rotate(45 ${cx} ${stripY})`} fill={c} fillOpacity={0.7} stroke={c} data-testid="graph-swap" />
          })}
        </svg>
      </div>

      {/* Legend: region colours + mark shapes */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing.gapMd, marginTop: spacing.gapSm, fontSize: '0.8rem', color: colors.textSecondary }}>
        {regions.map((r) => (
          <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: colourOf(r), display: 'inline-block' }} /> {r}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>○ deal · △ auction · ◇ swap (no price)</span>
      </div>
      {priced.length === 0 && swaps.length === 0 && (
        <p style={{ color: colors.textSecondary, fontSize: '0.85rem', marginTop: spacing.gapSm }} data-testid="graph-empty">
          No transactions yet — marks appear here as teams trade.
        </p>
      )}
    </section>
  )
}
