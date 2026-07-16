import { type CSSProperties, useEffect, useState } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { placeBid, type TeamState, type AuctionState } from '../api'
import { money, regionValue, clock, type RegionSchedule } from './shared'

// ── General tab (v3 §11.1) — your team's own view: identity + password, live portfolio,
// the private synergy table, and the active auctions (with your bid). Cash / available /
// portfolio come from getTeamState (authoritative); per-region holdings are derived from the
// public license board × your own synergy. Nothing here is another team's private data.

type Holding = { region: string; count: number }

export default function GeneralTab({
  teamNumber, teamPassword, synergy,
  teamState, holdings, openAuctions, myTeam, onActed,
}: {
  teamNumber: number
  teamPassword: string
  synergy: RegionSchedule[]
  teamState: TeamState | null
  holdings: Holding[]
  openAuctions: AuctionState[]
  myTeam: number
  onActed: () => void
}) {
  const synergyByRegion = new Map(synergy.map((s) => [s.region, s]))

  return (
    <div data-testid="general-tab">
      <p style={{ lineHeight: 1.6, marginTop: 0, marginBottom: spacing.gapMd }}>
        You are <strong data-testid="team-number">Team {teamNumber}</strong>. Your team password is{' '}
        <strong data-testid="team-password" style={{ fontFamily: 'monospace', fontSize: '1.05em' }}>{teamPassword}</strong>{' '}
        — a counterparty types this on your screen to authorize a trade. Keep it to your team.
      </p>

      {/* Live headline figures */}
      <div style={statRow}>
        <Stat label="License Value" value={money(teamState?.license_value)} />
        <Stat label="Cash" value={money(teamState?.cash)} testid="cash" />
        <Stat label="Portfolio Value" value={money(teamState?.portfolio_value)} testid="portfolio-value" />
        <Stat label="Available cash" value={money(teamState?.available)} testid="available" sub="cash − live bids" />
      </div>

      {/* Portfolio: region / quantity / value (live) */}
      <h2 style={h2}>Your portfolio</h2>
      {holdings.length === 0 ? (
        <p style={{ color: colors.textSecondary }}>You hold no licenses — you are all cash.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', marginBottom: spacing.gapMd }} data-testid="portfolio-table">
          <thead><tr><th style={th}>Region</th><th style={th}>Quantity</th><th style={th}>Value</th></tr></thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.region}>
                <td style={{ ...td, fontWeight: 700 }}>{h.region}</td>
                <td style={td}>{h.count}</td>
                <td style={td}>{money(regionValue(synergyByRegion.get(h.region), h.count))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AuctionsPanel openAuctions={openAuctions} myTeam={myTeam} available={teamState?.available ?? 0} onActed={onActed} />

      {/* Private synergy table */}
      <h2 style={h2}>Your private synergy table</h2>
      <p style={{ color: colors.textSecondary, marginTop: 0, marginBottom: spacing.gapSm, fontSize: '0.85rem', lineHeight: 1.5 }}>
        The value your team gets from holding 1–8 licenses in each region — yours alone. Concentrating in one region is worth disproportionately more.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table data-testid="synergy-table" style={{ borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 520 }}>
          <thead>
            <tr><th style={th}>Region</th>{Array.from({ length: 8 }, (_, i) => <th key={i} style={th}>{i + 1}</th>)}</tr>
          </thead>
          <tbody>
            {/* All regions × 1–8, no holding/endowment markers — the portfolio table above is
                the single source of what you currently hold (a synergy dot went stale on sale). */}
            {synergy.map((row) => (
              <tr key={row.region}>
                <td style={{ ...td, fontWeight: 700, textAlign: 'left' }}>{row.region}</td>
                {row.values.map((v, i) => <td key={i} style={td}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Active auctions + bid (v3 §7). Reserve is NEVER shown. Losers see only that they lost. ──
function AuctionsPanel({ openAuctions, myTeam, available, onActed }: {
  openAuctions: AuctionState[]; myTeam: number; available: number; onActed: () => void
}) {
  return (
    <>
      <h2 style={h2}>Active auctions</h2>
      {openAuctions.length === 0 ? (
        <p style={{ color: colors.textSecondary }} data-testid="no-auctions">No auctions running right now.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapSm, marginBottom: spacing.gapMd }} data-testid="auctions-list">
          {openAuctions.map((a) => (
            <AuctionCard key={a.auction_id} a={a} myTeam={myTeam} available={available} onActed={onActed} />
          ))}
        </div>
      )}
    </>
  )
}

function AuctionCard({ a, myTeam, available, onActed }: { a: AuctionState; myTeam: number; available: number; onActed: () => void }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // Live 1-second countdown (dry-run item 7 — DISPLAY ONLY; settlement is server-side via the
  // auction's own ends_at task, untouched). The parent polls getAuctionState every 5s, so the
  // server's time_remaining_ms only refreshes every 5s and the readout used to jump in 5s steps.
  // We anchor an absolute local deadline from each fresh poll (Date.now() + time_remaining_ms) and
  // tick it down every second in between; each poll re-anchors it, correcting any drift.
  const [deadline, setDeadline] = useState(() => Date.now() + a.time_remaining_ms)
  useEffect(() => { setDeadline(Date.now() + a.time_remaining_ms) }, [a.time_remaining_ms])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const remaining = Math.max(0, deadline - now)

  const mine = a.seller_team === myTeam
  const alreadyBid = a.your_bid != null
  const bid = () => {
    setBusy(true); setErr(null); setMsg(null)
    placeBid({ auction_id: a.auction_id, amount: Number(amount) })
      .then(() => { setMsg('✓ bid placed'); setAmount(''); onActed() })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Bid failed.'))
      .finally(() => setBusy(false))
  }

  return (
    <div data-testid={`auction-${a.auction_id}`} style={{ border: '1px solid #d0d7de', borderRadius: 6, padding: '0.5rem 0.75rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <div><strong>Region {a.region}</strong> · {a.quantity} unit{a.quantity === 1 ? '' : 's'} · Team {a.seller_team} selling</div>
      <div style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>ends in {clock(remaining)}</div>
      {mine ? (
        <span style={{ color: colors.textSecondary, fontSize: '0.85rem' }}>Your auction — you can't bid.</span>
      ) : alreadyBid ? (
        <span data-testid={`your-bid-${a.auction_id}`} style={{ fontSize: '0.85rem' }}>Your bid: {money(a.your_bid)} (sealed — no revisions)</span>
      ) : (
        <>
          <input type="number" min={0} value={amount} placeholder="your bid" onChange={(e) => setAmount(e.target.value)}
            style={{ padding: '0.3rem 0.4rem', width: 110, border: '1px solid #ccc', borderRadius: 4 }} data-testid={`bid-input-${a.auction_id}`} />
          <button onClick={bid} disabled={busy || !amount} data-testid={`bid-submit-${a.auction_id}`} style={{ padding: '0.35rem 0.7rem' }}>Place bid</button>
          <span style={{ color: colors.textSecondary, fontSize: '0.78rem' }}>avail {money(available)}</span>
        </>
      )}
      {err && <span style={{ color: '#c00', fontSize: '0.82rem', flexBasis: '100%' }}>{err}</span>}
      {msg && <span style={{ color: '#137333', fontSize: '0.82rem', flexBasis: '100%' }}>{msg}</span>}
    </div>
  )
}

function Stat({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid?: string }) {
  return (
    <div>
      <div style={{ color: colors.textSecondary, fontSize: '0.82rem' }}>{label}</div>
      <div data-testid={testid} style={{ fontWeight: 700, fontSize: '1.15rem' }}>{value}</div>
      {sub && <div style={{ color: colors.textSecondary, fontSize: '0.72rem' }}>{sub}</div>}
    </div>
  )
}

const statRow: CSSProperties = {
  display: 'flex', gap: spacing.gapXl, flexWrap: 'wrap', padding: '0.75rem 1rem',
  border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd', marginBottom: spacing.gapMd,
}
const h2: CSSProperties = { fontSize: '1.1rem', marginBottom: spacing.gapSm, marginTop: spacing.gapLg }
const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.3rem 0.6rem', background: '#f6f8fa', textAlign: 'right' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.3rem 0.6rem', textAlign: 'right' }
