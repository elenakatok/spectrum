import { useEffect, useState, type CSSProperties } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { colors, layout, spacing, typography } from '@mygames/game-ui'

// ── Spectrum MarketRoom (Slice 0 proof surface) ──────────────────────────────────
// The "beat between the two buttons": after the instructor presses Group Participants
// (status 'grouped'), students land in their team and read their dossier BEFORE the
// market opens. This shows exactly what Slice 0 must prove landed: team number, team
// password, the endowment (4 licenses in 4 distinct regions), Portfolio Value 1400,
// and the team's PRIVATE synergy table. The live trading UI (five tabs, ownership
// board, deals/swaps/auctions) replaces this in Slice 3 — this is the team-dossier stub.
//
// All fields are read from the student's OWN participant doc (server-stamped at grouping).
// A student can only read their own doc, so no other team's data is ever reachable here.

type RegionSchedule = {
  region: string
  regionIndex?: number
  schedule: number
  values: number[] // value(1..8)
}

type TeamInfo = {
  team_number?: number
  team_password?: string
  team_synergy?: RegionSchedule[]
  team_endowment_regions?: string[]
  team_license_ids?: string[]
  team_cash?: number
  team_license_value?: number
  team_portfolio_value?: number
}

const money = (n: number | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')

export default function MarketRoom({
  participantId,
  gameInstanceId,
}: {
  participantId: string
  gameInstanceId: string
}) {
  const [info, setInfo] = useState<TeamInfo | null>(null)

  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'participants', participantId)
    return onSnapshot(ref, (snap) => setInfo((snap.data() ?? {}) as TeamInfo))
  }, [participantId, gameInstanceId])

  const hasTeam = info?.team_number != null

  return (
    <main
      data-testid="market-room"
      style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto', fontFamily: typography.fontFamily }}
    >
      {!hasTeam ? (
        <>
          <h1 style={{ marginTop: 0 }}>You&apos;re in the market</h1>
          <p style={{ lineHeight: 1.6, color: colors.textSecondary }}>
            You&apos;ve been placed in the market. Your team and portfolio will appear here the
            moment your instructor groups the room — stay on this page.
          </p>
        </>
      ) : (
        <>
          <h1 style={{ marginTop: 0 }}>
            You&apos;re in the market — <span data-testid="team-number">Team {info!.team_number}</span>
          </h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapMd }}>
            Your team password is{' '}
            <strong data-testid="team-password" style={{ fontFamily: 'monospace', fontSize: '1.1em' }}>
              {info!.team_password}
            </strong>
            . A counterparty types this on your screen to authorize a trade — keep it to your team.
          </p>

          {/* Portfolio summary */}
          <div
            style={{
              display: 'flex', gap: spacing.gapMd, flexWrap: 'wrap',
              padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 8,
              background: '#fbfcfd', marginBottom: spacing.gapMd,
            }}
          >
            <div><div style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>License Value</div>
              <div style={{ fontWeight: 700, fontSize: '1.15rem' }}>{money(info!.team_license_value)}</div></div>
            <div><div style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>Cash</div>
              <div style={{ fontWeight: 700, fontSize: '1.15rem' }}>{money(info!.team_cash)}</div></div>
            <div><div style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>Portfolio Value</div>
              <div data-testid="portfolio-value" style={{ fontWeight: 700, fontSize: '1.15rem' }}>{money(info!.team_portfolio_value)}</div></div>
          </div>

          {/* Endowment */}
          <p style={{ marginBottom: spacing.gapSm }}>
            <strong>Your licenses:</strong>{' '}
            <span data-testid="endowment">{(info!.team_license_ids ?? []).join(', ') || '—'}</span>{' '}
            <span style={{ color: colors.textSecondary }}>
              (one each in regions {(info!.team_endowment_regions ?? []).join(', ')})
            </span>
          </p>

          {/* Private synergy table */}
          <h2 style={{ fontSize: '1.1rem', marginBottom: spacing.gapSm }}>
            Your private synergy table
          </h2>
          <p style={{ color: colors.textSecondary, marginTop: 0, marginBottom: spacing.gapSm, lineHeight: 1.5 }}>
            The value your team gets from holding 1–8 licenses in each region. This is yours
            alone — concentrating licenses in one region is worth disproportionately more.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table
              data-testid="synergy-table"
              style={{ borderCollapse: 'collapse', fontSize: '0.9rem', minWidth: 520 }}
            >
              <thead>
                <tr>
                  <th style={th}>Region</th>
                  {Array.from({ length: 8 }, (_, i) => (
                    <th key={i} style={th}>{i + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(info!.team_synergy ?? []).map((row) => {
                  const owned = (info!.team_endowment_regions ?? []).includes(row.region)
                  return (
                    <tr key={row.region} style={owned ? { background: '#fff6e9' } : undefined}>
                      <td style={{ ...td, fontWeight: 700 }}>
                        {row.region}{owned ? ' ●' : ''}
                      </td>
                      {row.values.map((v, i) => (
                        <td key={i} style={td}>{v}</td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: colors.textSecondary, fontSize: '0.85rem', marginTop: spacing.gapSm }}>
            ● marks a region you already hold. Trading opens when your instructor starts the market.
          </p>
        </>
      )}
    </main>
  )
}

const th: CSSProperties = {
  border: '1px solid #d0d7de', padding: '0.35rem 0.6rem', background: '#f6f8fa', textAlign: 'right',
}
const td: CSSProperties = {
  border: '1px solid #d0d7de', padding: '0.35rem 0.6rem', textAlign: 'right',
}
