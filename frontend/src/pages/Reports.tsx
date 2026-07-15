import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  GameHeader,
  ExportModal,
  buildStudentTextExport,
  type SortableColumn,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import {
  getLeaderboard, getTransactionGraph, getMarketReport,
  type ReportData, type StudentReportRow,
  type Leaderboard, type TransactionGraph as TxGraph, type MarketReport, type ReportTransaction,
} from '../api'
import { money, clock } from '../market/shared'
import TransactionGraph from '../market/TransactionGraph'

// SLICE 6 — Reports (post-close debrief toolkit, v3 §13). Five reports, almost all pure
// presentation on data existing callables already return:
//   1 Leaderboard          — getLeaderboard (per-team financials + the four room figures)
//   2 Transaction history  — getTransactionGraph (full price ledger + the Slice-4 graph) · INSTRUCTOR-ONLY
//   3 Per-region gains     — getMarketReport.regions (synergy × ownership)                · INSTRUCTOR-ONLY
//   4 Per-team             — getMarketReport.teams + .transactions (attributed ledger)
//   5 Per-student          — getReportData (participation + KC + free-text — the grade)
// getMarketReport is the ONE new callable (Reports 3 & 4); it is instructor-only by construction.

// ── Formatting ──────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = { trader: 'Trader' }
const fmtKc = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`
const elapsed = (atMs: number | null, openedAt: number | null) =>
  atMs != null && openedAt != null ? clock(Math.max(0, atMs - openedAt)) : '—'

const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', background: '#f6f8fa', textAlign: 'right', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }
const thL: CSSProperties = { ...th, textAlign: 'left' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdL: CSSProperties = { ...td, textAlign: 'left', fontVariantNumeric: 'normal' }
const statBox: CSSProperties = { flex: '1 1 170px', minWidth: 150, padding: '0.6rem 0.9rem', border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd' }
const noteStyle: CSSProperties = { fontSize: '0.82rem', color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.6rem 0.8rem', margin: '0 0 0.9rem', lineHeight: 1.5 }

function Stat({ label, value, hint, testid }: { label: string; value: string; hint?: string; testid?: string }) {
  return (
    <div style={statBox} data-testid={testid}>
      <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

// ── Per-student report (participation + KC are the grade) ─────────────────────────

type StudentSortKey = 'name' | 'group' | 'role' | 'participation' | 'kc'

const STUDENT_COLUMNS: readonly SortableColumn<StudentReportRow, StudentSortKey>[] = [
  { key: 'name', label: 'Name', sticky: 'left', headerStyle: { minWidth: 140 },
    render: r => r.display_name, compare: (a, b) => a.display_name.localeCompare(b.display_name) },
  { key: 'group', label: 'Team #',
    render: r => r.group_number ?? '—', compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity) },
  { key: 'role', label: 'Role',
    render: r => ROLE_LABELS[r.role] ?? r.role, compare: (a, b) => a.role.localeCompare(b.role) },
  { key: 'participation', label: 'Participation (grade)', nullsLast: true, isNull: r => r.participation == null,
    render: r => r.participation == null ? '—' : <span data-testid="report-participation" style={{ fontVariantNumeric: 'tabular-nums' }}>{r.participation}</span>,
    compare: (a, b) => (a.participation ?? 0) - (b.participation ?? 0) },
  { key: 'kc', label: 'KC score (grade)', nullsLast: true, isNull: r => r.knowledge_check_score == null,
    render: r => <span data-testid="report-kc" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKc(r.knowledge_check_score)}</span>,
    compare: (a, b) => (a.knowledge_check_score ?? 0) - (b.knowledge_check_score ?? 0) },
]

// ── Modal shell ───────────────────────────────────────────────────────────────────

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', width: '100%', maxWidth: wide ? 'min(1200px, calc(100vw - 2rem))' : 'min(1000px, calc(100vw - 2rem))', minWidth: 0, boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Report 1: Leaderboard (getLeaderboard) ────────────────────────────────────────
function LeaderboardReport({ board }: { board: Leaderboard }) {
  const eff = board.efficient_market_value
  // The SAME unified efficiency measure as the live dashboard (Slice 5): gains realized /
  // gains available = (achieved − initial) / (efficient − initial). NOT a second definition.
  const captured = eff > board.total_initial_value
    ? Math.round(((board.value_after_trade - board.total_initial_value) / (eff - board.total_initial_value)) * 100)
    : 0
  // Every team opens at the same portfolio (400 license + starting cash); the delta column is
  // vs that opening baseline. total_initial_value / N = 1400 in the standard config.
  const baseline = board.teams.length ? board.total_initial_value / board.teams.length : 0
  return (
    <section data-testid="report-leaderboard">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.7rem', marginBottom: '1rem' }}>
        <Stat label="Efficient Market Value" value={money(eff)} hint="ceiling if every license landed on its best-fit team" testid="rep-efficient-market-value" />
        <Stat label="Total Initial Value" value={money(board.total_initial_value)} hint="portfolios at grouping, before any trade" testid="rep-total-initial-value" />
        <Stat label="Value After Trade" value={money(board.value_after_trade)} hint={`Efficiency captured: ${captured}% of available gains`} testid="rep-value-after-trade" />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', width: '100%', maxWidth: 720 }} data-testid="report-leaderboard-table">
          <thead>
            <tr>
              <th style={th}>Rank</th><th style={thL}>Team</th>
              <th style={th}>Cash</th><th style={th}>License Value</th>
              <th style={th}>Portfolio Value</th><th style={th}>Δ vs open</th>
            </tr>
          </thead>
          <tbody>
            {board.teams.map((t, i) => {
              const delta = t.portfolio_value - baseline
              return (
                <tr key={t.team_number} data-testid={`report-lb-row-${t.team_number}`}>
                  <td style={td}>{i + 1}</td>
                  <td style={{ ...tdL, fontWeight: 600 }}>Team {t.team_number}</td>
                  <td style={td}>{money(t.cash)}</td>
                  <td style={td}>{money(t.license_value)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{money(t.portfolio_value)}</td>
                  <td style={{ ...td, color: delta >= 0 ? '#137333' : '#b3261e' }}>{signed(delta)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Report 2: Transaction history + price graph (getTransactionGraph — INSTRUCTOR ONLY) ─
function HistoryReport({ graph }: { graph: TxGraph }) {
  const now = Date.now()
  const detailOf = (p: TxGraph['points'][number]) =>
    p.type === 'swap' ? 'swap' : `${p.quantity ?? '—'} × Region ${p.region ?? '—'}`
  return (
    <section data-testid="report-history">
      <p style={noteStyle}>
        The full price ledger — every settled deal, auction, and swap, with prices, quantities, and elapsed-time
        stamps. This report is <strong>instructor-only</strong>: there is no student path to the cross-team price stream.
      </p>
      {/* The graph is secondary to the ledger here — cap its footprint so the table below always
          gets a visible, scrollable region (the graph scales down; on the /market view it's full size). */}
      <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.5rem', marginBottom: '1rem', maxWidth: 560, margin: '0 auto 1rem' }}>
        <TransactionGraph points={graph.points} openedAt={graph.opened_at} nowMs={now} />
      </div>
      <div style={{ overflow: 'auto', maxHeight: '42vh', minHeight: 180, border: '1px solid #ddd', borderRadius: 6 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', width: '100%' }} data-testid="report-history-table">
          <thead>
            <tr>
              <th style={thL}>Time</th><th style={thL}>Type</th><th style={thL}>Detail</th>
              <th style={th}>Quantity</th><th style={th}>Price</th><th style={th}>Price / license</th>
            </tr>
          </thead>
          <tbody>
            {graph.points.map((p, i) => (
              <tr key={i} data-testid={`report-history-row-${i}`}>
                <td style={tdL}>{elapsed(p.at_ms, graph.opened_at)}</td>
                <td style={{ ...tdL, textTransform: 'capitalize' }}>{p.type}</td>
                <td style={tdL}>{detailOf(p)}</td>
                <td style={td}>{p.quantity ?? '—'}</td>
                <td style={td}>{p.price != null ? money(p.price) : '—'}</td>
                <td style={td}>{p.price_per_license != null ? money(p.price_per_license) : '—'}</td>
              </tr>
            ))}
            {graph.points.length === 0 && <tr><td style={tdL} colSpan={6}>No transactions recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Report 3: Per-region gains-from-trade (getMarketReport.regions — INSTRUCTOR ONLY) ──
function RegionGainsReport({ report }: { report: MarketReport }) {
  // Sorted by gap descending — the regions FURTHEST from efficient concentration surface first.
  const rows = [...report.regions].sort((a, b) => b.gap - a.gap)
  return (
    <section data-testid="report-regions">
      <p style={noteStyle}>
        How far each region ended from <strong>efficient concentration</strong> — not who "won" a region.
        <em> Efficient value</em> is the most a region is worth if its eight licenses all sit on their best-fit
        team; <em>realized value</em> sums what each current holder&apos;s own synergy makes of what it holds; the
        <em> gap</em> is the gains-from-trade still on the table. The named teams are simply the two with the
        strongest synergy here — <strong>not</strong> winners, and usually neither ended up holding the block.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', width: '100%', maxWidth: 760 }} data-testid="report-regions-table">
          <thead>
            <tr>
              <th style={thL}>Region</th><th style={th}>Efficient value</th><th style={th}>Realized value</th>
              <th style={th}>Gap</th><th style={thL}>Strongest synergy here</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.region} data-testid={`report-region-row-${r.region}`}>
                <td style={{ ...tdL, fontWeight: 600 }}>Region {r.region}</td>
                <td style={td}>{money(r.efficient_value)}</td>
                <td style={td}>{money(r.realized_value)}</td>
                <td style={{ ...td, fontWeight: 700, color: r.gap > 0 ? '#b3261e' : '#137333' }}>{money(r.gap)}</td>
                <td style={tdL}>{r.top_synergy_teams.map(n => `Team ${n}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Report 4: Per-team (getMarketReport.teams + .transactions) ────────────────────────
function PerTeamReport({ report }: { report: MarketReport }) {
  const [team, setTeam] = useState<number>(report.teams[0]?.team_number ?? 1)
  const detail = report.teams.find(t => t.team_number === team)
  const txs = useMemo(
    () => report.transactions.filter(t => t.from_team === team || t.to_team === team),
    [report.transactions, team],
  )
  const auctionsWon = txs.filter(t => t.type === 'auction' && t.to_team === team).length
  const auctionsSold = txs.filter(t => t.type === 'auction' && t.from_team === team).length

  // Row description from the SELECTED team's point of view.
  const describe = (t: ReportTransaction): { action: string; counterparty: number | null; detail: string } => {
    const other = t.from_team === team ? t.to_team : t.from_team
    if (t.type === 'deal') return { action: t.from_team === team ? 'Sold' : 'Bought', counterparty: other, detail: `${t.quantity ?? '—'} × Region ${t.region ?? '—'}` }
    if (t.type === 'auction') return { action: t.to_team === team ? 'Won auction' : 'Auctioned', counterparty: other, detail: `${t.quantity ?? '—'} × Region ${t.region ?? '—'}` }
    // swap: from_team gave X, got Y. Flip the framing if the selected team is the partner.
    const gaveX = t.from_team === team
    const gave = gaveX ? `${t.quantity_x ?? '—'} × ${t.region_x ?? '—'}` : `${t.quantity_y ?? '—'} × ${t.region_y ?? '—'}`
    const got = gaveX ? `${t.quantity_y ?? '—'} × ${t.region_y ?? '—'}` : `${t.quantity_x ?? '—'} × ${t.region_x ?? '—'}`
    return { action: 'Swapped', counterparty: other, detail: `gave ${gave}, got ${got}` }
  }

  return (
    <section data-testid="report-per-team">
      <label style={{ display: 'block', marginBottom: '0.9rem', fontSize: '0.9rem' }}>
        <span style={{ marginRight: '0.5rem', color: '#475569' }}>Team:</span>
        <select value={team} onChange={e => setTeam(Number(e.target.value))} data-testid="report-team-select"
          style={{ padding: '0.3rem 0.6rem', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.9rem' }}>
          {report.teams.map(t => <option key={t.team_number} value={t.team_number}>Team {t.team_number}</option>)}
        </select>
      </label>

      {detail && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.7rem', marginBottom: '1rem' }}>
            <Stat label="Auctions won" value={String(auctionsWon)} testid="rep-auctions-won" />
            <Stat label="Auctions sold" value={String(auctionsSold)} hint="settled auctions this team ran" testid="rep-auctions-sold" />
            <Stat label="Trades on the ledger" value={String(txs.length)} testid="rep-trade-count" />
          </div>

          {/* Holdings + synergy realized: which regions this team concentrated. */}
          <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.92rem' }}>Holdings &amp; synergy realized</h4>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0 0 0.5rem' }}>
            Value is this team&apos;s own synergy applied to what it now holds. Regions with 4+ licenses (where the
            concentration bonuses kick in) are flagged ●.
          </p>
          <div style={{ overflowX: 'auto', marginBottom: '1.2rem' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.88rem', width: '100%', maxWidth: 520 }} data-testid="report-team-holdings">
              <thead>
                <tr><th style={thL}>Region</th><th style={th}>Licenses held</th><th style={th}>Value (own synergy)</th></tr>
              </thead>
              <tbody>
                {detail.holdings.map(h => (
                  <tr key={h.region} data-testid={`report-team-holding-${h.region}`} style={h.count >= 4 ? { background: '#eef7ee' } : undefined}>
                    <td style={{ ...tdL, fontWeight: 600 }}>Region {h.region}{h.count >= 4 ? ' ●' : ''}</td>
                    <td style={td}>{h.count}</td>
                    <td style={td}>{money(h.value)}</td>
                  </tr>
                ))}
                {detail.holdings.length === 0 && <tr><td style={tdL} colSpan={3}>Holds no licenses.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Individual member activity. */}
          <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.92rem' }}>Members</h4>
          <div style={{ overflowX: 'auto', marginBottom: '1.2rem' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.88rem', width: '100%', maxWidth: 520 }} data-testid="report-team-members">
              <thead>
                <tr><th style={thL}>Name</th><th style={th}>Deals / swaps initiated</th></tr>
              </thead>
              <tbody>
                {detail.members.map(m => (
                  <tr key={m.participant_id} data-testid={`report-member-${m.participant_id}`}>
                    <td style={tdL}>{m.display_name}</td>
                    <td style={td}>{m.action_count}</td>
                  </tr>
                ))}
                {detail.members.length === 0 && <tr><td style={tdL} colSpan={2}>No members on this team.</td></tr>}
              </tbody>
            </table>
          </div>

          {/* This team's own transactions. */}
          <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.92rem' }}>This team&apos;s trades</h4>
          <div style={{ overflowX: 'auto', maxHeight: '34vh', border: '1px solid #ddd', borderRadius: 6 }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem', width: '100%' }} data-testid="report-team-trades">
              <thead>
                <tr>
                  <th style={thL}>Time</th><th style={thL}>Action</th><th style={thL}>Counterparty</th>
                  <th style={thL}>Detail</th><th style={th}>Price</th><th style={thL}>By</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t, i) => {
                  const d = describe(t)
                  return (
                    <tr key={t.transaction_id} data-testid={`report-team-trade-${i}`}>
                      <td style={tdL}>{elapsed(t.at_ms, report.opened_at)}</td>
                      <td style={tdL}>{d.action}</td>
                      <td style={tdL}>{d.counterparty != null ? `Team ${d.counterparty}` : '—'}</td>
                      <td style={tdL}>{d.detail}</td>
                      <td style={td}>{t.price != null ? money(t.price) : '—'}</td>
                      <td style={tdL}>{t.acted_by_name ?? (t.type === 'auction' ? 'system' : '—')}</td>
                    </tr>
                  )
                })}
                {txs.length === 0 && <tr><td style={tdL} colSpan={6}>This team made no trades.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

type ReportKind = 'student' | 'leaderboard' | 'history' | 'regions' | 'team'

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam) return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId ? { _dev: { game_instance_id: devGameInstanceId } } : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data ─────────────────────────────────────────────────────────────────────
  const [data, setData] = useState<ReportData | null>(null)
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [graph, setGraph] = useState<TxGraph | null>(null)
  const [market, setMarket] = useState<MarketReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true); setError(null)
    const studentFn = httpsCallable<object, ReportData>(functions, 'getReportData')
    void Promise.allSettled([
      studentFn({}).then(r => setData(r.data)),
      getLeaderboard().then(setBoard),
      getTransactionGraph().then(setGraph),
      getMarketReport().then(setMarket),
    ]).then((results) => {
      const firstErr = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (firstErr) setError(firstErr.reason instanceof Error ? firstErr.reason.message : 'Some reports failed to load.')
      setLoading(false)
    })
  }, [sessionReady])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [activeExport, setActiveExport] = useState<{ title: string; text: string } | null>(null)

  const rows = data?.rows ?? []
  const questions = data?.questions ?? []

  const tiles: ReportTileConfig[] = [
    {
      id: 'leaderboard', title: 'Leaderboard — final standings',
      preview: board
        ? <span style={{ fontSize: '0.9rem', color: '#555' }}>{board.teams.length} teams · {money(board.value_after_trade)} after trade</span>
        : <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading…</span>,
      onOpen: () => setActive('leaderboard'), disabled: !board, actionLabel: 'Open ↗',
    },
    {
      id: 'history', title: 'Transaction history (instructor-only)',
      preview: graph
        ? <span style={{ fontSize: '0.9rem', color: '#555' }}>{graph.points.length} transaction{graph.points.length !== 1 ? 's' : ''}</span>
        : <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading…</span>,
      onOpen: () => setActive('history'), disabled: !graph, actionLabel: 'Open ↗',
    },
    {
      id: 'regions', title: 'Per-region gains from trade (instructor-only)',
      preview: market
        ? <span style={{ fontSize: '0.9rem', color: '#555' }}>{market.regions.length} regions · {money(market.regions.reduce((s, r) => s + r.gap, 0))} gap</span>
        : <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading…</span>,
      onOpen: () => setActive('regions'), disabled: !market, actionLabel: 'Open ↗',
    },
    {
      id: 'per-team', title: 'Per-team report',
      preview: market
        ? <span style={{ fontSize: '0.9rem', color: '#555' }}>{market.teams.length} teams · {market.transactions.length} transactions</span>
        : <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading…</span>,
      onOpen: () => setActive('team'), disabled: !market, actionLabel: 'Open ↗',
    },
    {
      id: 'per-student', title: 'Per-student report (participation + KC)',
      preview: <span style={{ fontSize: '0.9rem', color: '#555' }}>{rows.length} student{rows.length !== 1 ? 's' : ''} finalized</span>,
      onOpen: () => setActive('student'), disabled: rows.length === 0, actionLabel: 'Open ↗',
    },
    ...questions.map(q => {
      const roleLabel = ROLE_LABELS[q.role_target] ?? q.role_target
      const tileTitle = `${roleLabel}: ${q.prompt}`
      const qRows: AiTextRow[] = rows.filter(r => r.role === q.role_target && r.text_answers[q.field])
        .map(r => ({ name: r.display_name, raw_score: r.participation, answer: r.text_answers[q.field] }))
      const text = buildStudentTextExport(tileTitle, qRows)
      return {
        id: q.field, title: tileTitle,
        preview: qRows.length === 0
          ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
          : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>{qRows.length} response{qRows.length !== 1 ? 's' : ''}</span>,
        onOpen: () => setActiveExport({ title: tileTitle, text }), disabled: rows.length === 0, actionLabel: 'Open ↗',
      } satisfies ReportTileConfig
    }),
  ]

  if (authError) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}><p style={{ color: '#c00' }}>{authError}</p></div>
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />
      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => navigate(makeLink('/dashboard'))} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}>← Dashboard</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — Spectrum</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        {loading && !data && <p style={{ color: '#888' }}>Loading…</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }} data-testid="report-tiles">
          {tiles.map(t => (
            <div key={t.id} style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: '1rem', background: '#fff', display: 'flex', flexDirection: 'column', gap: '0.6rem', opacity: t.disabled ? 0.55 : 1 }} data-testid={`report-tile-${t.id}`}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{t.title}</div>
              <div style={{ flex: 1 }}>{t.preview}</div>
              <button onClick={t.onOpen} disabled={t.disabled}
                style={{ alignSelf: 'flex-start', background: t.disabled ? '#e2e8f0' : '#D38626', color: t.disabled ? '#94a3b8' : '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.9rem', cursor: t.disabled ? 'default' : 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                {t.actionLabel ?? 'Open ↗'}
              </button>
            </div>
          ))}
        </div>
      </main>

      {active === 'leaderboard' && board && (
        <Modal title="Leaderboard — final standings" wide onClose={() => setActive(null)}><LeaderboardReport board={board} /></Modal>
      )}
      {active === 'history' && graph && (
        <Modal title="Transaction history (instructor-only)" wide onClose={() => setActive(null)}><HistoryReport graph={graph} /></Modal>
      )}
      {active === 'regions' && market && (
        <Modal title="Per-region gains from trade (instructor-only)" wide onClose={() => setActive(null)}><RegionGainsReport report={market} /></Modal>
      )}
      {active === 'team' && market && (
        <Modal title="Per-team report" wide onClose={() => setActive(null)}><PerTeamReport report={market} /></Modal>
      )}
      {active === 'student' && (
        <Modal title="Per-student report" wide onClose={() => setActive(null)}>
          <p style={{ fontSize: '0.85rem', color: '#444', margin: '0 0 0.75rem' }}>
            The grade is <strong>Participation</strong> (present = 1) + <strong>KC score</strong>.
            A team&apos;s portfolio value never enters the grade.
          </p>
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 16rem)', border: '1px solid #ddd', borderRadius: 6 }}>
            <SortableTable<StudentReportRow, StudentSortKey>
              rows={rows} columns={STUDENT_COLUMNS}
              getRowKey={r => r.participant_id} initialSortKey="group"
              roleLabels={ROLE_LABELS} getRowRole={r => r.role}
              emptyMessage="No finalized participants yet." wrapHeaders />
          </div>
        </Modal>
      )}

      {activeExport && <ExportModal title={activeExport.title} text={activeExport.text} onClose={() => setActiveExport(null)} />}
    </div>
  )
}
