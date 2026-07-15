import { type CSSProperties, type ReactNode, useMemo } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import type { LicenseDoc } from './shared'

// ── The public Ownership board (v3 §11.2) — BUILD ONCE, reuse on the Slice-4 projector. ──
// One row per region, one cell per license, showing the OWNING TEAM. A team appearing
// twice in a row is visibly building a block (highlighted). NO prices, NO cash, NO
// timestamps — this component is fed only public license ownership.
//
// The instructor/projector variant (Slice 4) passes `headerRight` (the market clock) and
// `title`; the student variant passes neither. That is the ONLY difference — do not fork.

export type OwnershipBoardProps = {
  licenses: LicenseDoc[]
  /** Highlight the viewer's own team cells (student view). Omit on the projector. */
  myTeam?: number | null
  /** Injected into the header's right edge — the market clock on the projector (Slice 4). */
  headerRight?: ReactNode
  title?: string
}

export default function OwnershipBoard({ licenses, myTeam = null, headerRight, title = 'Ownership' }: OwnershipBoardProps) {
  // Group licenses by region, each region's cells sorted by license id (stable columns).
  const regions = useMemo(() => {
    const byRegion = new Map<string, LicenseDoc[]>()
    for (const l of licenses) {
      const arr = byRegion.get(l.region) ?? []
      arr.push(l)
      byRegion.set(l.region, arr)
    }
    return [...byRegion.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, ls]) => {
        const cells = [...ls].sort((x, y) => x.license_id.localeCompare(y.license_id))
        // Count owners in this region to flag block-building (same team ≥2 in a row).
        const counts = new Map<number, number>()
        for (const c of cells) counts.set(c.owner_team, (counts.get(c.owner_team) ?? 0) + 1)
        return { region, cells, counts }
      })
  }, [licenses])

  const maxCols = regions.reduce((m, r) => Math.max(m, r.cells.length), 0)

  return (
    <section data-testid="ownership-board">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.gapSm }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>{title}</h2>
        {headerRight}
      </div>
      <p style={{ color: colors.textSecondary, marginTop: 0, marginBottom: spacing.gapSm, fontSize: '0.85rem' }}>
        Who holds which licenses. A team shown twice in a row is building a block. No prices are ever shown here.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={hdr}>Region</th>
              {Array.from({ length: maxCols }, (_, i) => (
                <th key={i} style={hdr}>{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {regions.map(({ region, cells, counts }) => (
              <tr key={region}>
                <td style={{ ...cell, fontWeight: 700, textAlign: 'left' }}>{region}</td>
                {cells.map((c) => {
                  const block = (counts.get(c.owner_team) ?? 0) >= 2
                  const mine = myTeam != null && c.owner_team === myTeam
                  const auctioned = !!c.under_auction
                  return (
                    <td
                      key={c.license_id}
                      data-testid={`own-${c.license_id}`}
                      title={auctioned ? 'Under auction' : undefined}
                      style={{
                        // Under-auction is a distinct lock STATE — its tint wins over mine/block
                        // so it reads clearly on the projector (was a near-invisible faint dot).
                        ...cell,
                        background: auctioned ? '#fde2dd' : mine ? '#fff2dd' : block ? '#eef4ff' : undefined,
                        fontWeight: block ? 700 : 400,
                      }}
                    >
                      {c.owner_team}{auctioned ? ' 🔒' : ''}
                    </td>
                  )
                })}
                {Array.from({ length: maxCols - cells.length }, (_, i) => (
                  <td key={`pad-${i}`} style={cell} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: colors.textSecondary, fontSize: '0.78rem', marginTop: spacing.gapSm }}>
        Blue = one team holds two or more here. 🔒 (red) = under auction.{myTeam != null ? ' Amber = your team.' : ''}
      </p>
    </section>
  )
}

const hdr: CSSProperties = { border: '1px solid #d0d7de', padding: '0.3rem 0.55rem', background: '#f6f8fa', textAlign: 'center', minWidth: 34 }
const cell: CSSProperties = { border: '1px solid #d0d7de', padding: '0.3rem 0.55rem', textAlign: 'center' }
