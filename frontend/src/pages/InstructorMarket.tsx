import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { colors, layout, spacing, typography } from '@mygames/game-ui'
import {
  getLeaderboard, getTransactionGraph, getRoster, CLASSROOM_URL,
  type Leaderboard, type TransactionGraph as TxGraph, type RosterParticipant,
} from '../api'
import type { LicenseDoc } from '../market/shared'
import { money, clock } from '../market/shared'
import OwnershipBoard from '../market/OwnershipBoard'
import TransactionGraph from '../market/TransactionGraph'
import { useInstructorSession } from '../hooks/useInstructorSession'

// ── Spectrum Instructor market dashboard (Slice 4) — the projector view (v3 §12). ─────
// Five views behind a nav bar: Team Performance (getLeaderboard), Ownership (the SAME
// OwnershipBoard the students see — imported, never re-implemented), Transaction Graph
// (getTransactionGraph — instructor only, by construction), Teams (getRoster + the public
// groups, joined on the client), and Quiz Results (a classroom link — no market callable).
// Public data (ownership, market clock) rides onSnapshot; the two cross-team reads ride the
// instructor Bearer established by useInstructorSession.

type View = 'performance' | 'ownership' | 'graph' | 'teams' | 'quiz'
const VIEWS: { key: View; label: string }[] = [
  { key: 'performance', label: 'Team Performance' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'graph', label: 'Transaction Graph' },
  { key: 'teams', label: 'Teams' },
  { key: 'quiz', label: 'Quiz Results' },
]

type MarketDoc = { status?: string; closes_at?: number | null }
type GroupDoc = { team_number?: number; trader_participants?: string[] }

const ms = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function'
    ? (v as { toMillis: () => number }).toMillis()
    : typeof v === 'number' ? v : null

export default function InstructorMarket() {
  const { status: session, gameInstanceId, error } = useInstructorSession()

  if (session !== 'ready' || !gameInstanceId) {
    return (
      <main style={shell}>
        <h1 style={{ marginTop: 0 }}>Live market dashboard</h1>
        <p style={{ color: session === 'error' ? '#b3261e' : colors.textSecondary }}>
          {session === 'error' ? (error ?? 'Could not open the dashboard.') : 'Setting up session…'}
        </p>
      </main>
    )
  }
  return <Dashboard gameInstanceId={gameInstanceId} />
}

function Dashboard({ gameInstanceId }: { gameInstanceId: string }) {
  const [view, setView] = useState<View>('performance')
  const [now, setNow] = useState(() => Date.now())
  const [market, setMarket] = useState<MarketDoc | null>(null)
  const [licenses, setLicenses] = useState<LicenseDoc[]>([])

  const inst = (sub: string) => collection(db, 'game_instances', gameInstanceId, sub)

  // Public live collections: market clock + ownership board (same source the students read).
  useEffect(() => onSnapshot(doc(db, 'game_instances', gameInstanceId, 'market', 'state'), (s) => {
    const d = (s.data() ?? {}) as Record<string, unknown>
    setMarket({ status: d['status'] as string | undefined, closes_at: ms(d['closes_at']) })
  }), [gameInstanceId])
  useEffect(() => onSnapshot(inst('licenses'),
    (s) => setLicenses(s.docs.map((d) => d.data() as LicenseDoc))), [gameInstanceId])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])

  const status = market?.status ?? 'grouped'
  const timeLeft = market?.closes_at ? market.closes_at - now : null
  // HARD CLOSE (v3 §9.2): read "Market closed" at the deadline even before the server flips status.
  const deadlinePassed = timeLeft != null && timeLeft <= 0
  const marketOpen = status === 'open' && !deadlinePassed
  const marketClosed = status === 'closed' || (status === 'open' && deadlinePassed)
  const clockText = marketClosed ? 'Market closed'
    : marketOpen ? `● Market open${timeLeft != null ? ` · ${clock(timeLeft)} left` : ''}`
    : 'Waiting for the market to open'

  return (
    <main style={shell} data-testid="instructor-market">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.gapMd, marginBottom: spacing.gapSm }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Spectrum — Live market</h1>
        <div style={{ fontSize: '0.9rem', color: marketOpen ? '#137333' : colors.textSecondary, fontWeight: 600 }} data-testid="market-clock">
          {clockText}
        </div>
      </div>

      <div role="tablist" style={navBar}>
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} data-testid={`nav-${v.key}`}
            onClick={() => setView(v.key)} style={view === v.key ? navActive : navIdle}>
            {v.label}
          </button>
        ))}
      </div>

      <div style={{ paddingTop: spacing.gapMd }}>
        {view === 'performance' && <PerformanceView />}
        {view === 'ownership' && (
          <OwnershipBoard licenses={licenses} title="Ownership"
            headerRight={<span data-testid="ownership-clock" style={{ fontSize: '0.9rem', fontWeight: 600, color: marketOpen ? '#137333' : colors.textSecondary }}>{clockText}</span>} />
        )}
        {view === 'graph' && <GraphView />}
        {view === 'teams' && <TeamsView gameInstanceId={gameInstanceId} />}
        {view === 'quiz' && <QuizView />}
      </div>
    </main>
  )
}

// ── View 1: Team Performance (getLeaderboard) ────────────────────────────────────────
function PerformanceView() {
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [err, setErr] = useState('')
  const refresh = useCallback(() => {
    getLeaderboard().then(setBoard).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Load failed.'))
  }, [])
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh])

  if (err) return <p style={{ color: '#b3261e' }} data-testid="performance-error">{err}</p>
  if (!board) return <p style={{ color: colors.textSecondary }}>Loading…</p>

  const eff = board.efficient_market_value
  // ONE efficiency measure everywhere (matches the dashboard): efficiency captured = gains
  // realized / gains available = (achieved − initial) / (efficient − initial). Starts at 0% at
  // open and climbs toward 100% as the class finds gains from trade — what the game teaches.
  // (NOT achieved/efficient, which sits ~79% before any trade and barely moves — misleading.)
  const captured = eff > board.total_initial_value
    ? Math.round(((board.value_after_trade - board.total_initial_value) / (eff - board.total_initial_value)) * 100)
    : 0

  return (
    <section data-testid="performance-view">
      {/* Room aggregates */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing.gapMd, marginBottom: spacing.gapMd }}>
        <Stat label="Efficient Market Value" value={money(eff)} testid="efficient-market-value" hint="the ceiling if every license landed on its best-fit team" />
        <Stat label="Total Initial Value" value={money(board.total_initial_value)} testid="total-initial-value" hint="portfolios at grouping, before any trade" />
        <Stat label="Value After Trade" value={money(board.value_after_trade)} testid="value-after-trade" hint={`Efficiency captured: ${captured}% of available gains from trade`} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem', width: '100%', maxWidth: 640 }} data-testid="leaderboard-table">
          <thead>
            <tr>
              <th style={th}>Rank</th><th style={{ ...th, textAlign: 'left' }}>Team</th>
              <th style={th}>Cash</th><th style={th}>License Value</th><th style={th}>Portfolio Value</th>
            </tr>
          </thead>
          <tbody>
            {board.teams.map((t, i) => (
              <tr key={t.team_number} data-testid={`leaderboard-row-${t.team_number}`}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>Team {t.team_number}</td>
                <td style={td}>{money(t.cash)}</td>
                <td style={td}>{money(t.license_value)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{money(t.portfolio_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── View 3: Transaction Graph (getTransactionGraph — instructor only) ─────────────────
function GraphView() {
  const [graph, setGraph] = useState<TxGraph | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [err, setErr] = useState('')
  const refresh = useCallback(() => {
    getTransactionGraph().then(setGraph).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Load failed.'))
  }, [])
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])

  if (err) return <p style={{ color: '#b3261e' }} data-testid="graph-error">{err}</p>
  if (!graph) return <p style={{ color: colors.textSecondary }}>Loading…</p>
  return <TransactionGraph points={graph.points} openedAt={graph.opened_at} nowMs={now} />
}

// ── View 4: Teams (getRoster + public groups, joined on the client per Elena's choice) ─
function TeamsView({ gameInstanceId }: { gameInstanceId: string }) {
  const [groups, setGroups] = useState<GroupDoc[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())

  useEffect(() => onSnapshot(collection(db, 'game_instances', gameInstanceId, 'groups'),
    (s) => setGroups(s.docs.map((d) => d.data() as GroupDoc))), [gameInstanceId])
  useEffect(() => {
    getRoster()
      .then((r) => setNames(new Map(r.participants.map((p: RosterParticipant) => [p.participant_id, p.display_name]))))
      .catch(() => { /* transient — the view just shows IDs until it resolves */ })
  }, [gameInstanceId])

  const teams = useMemo(() => groups
    .filter((g) => g.team_number != null)
    .map((g) => ({
      team_number: g.team_number as number,
      members: (g.trader_participants ?? []).map((pid) => names.get(pid) ?? pid).filter((n) => n.length > 0),
    }))
    .sort((a, b) => a.team_number - b.team_number), [groups, names])

  if (teams.length === 0) return <p style={{ color: colors.textSecondary }}>Teams appear once the room is grouped.</p>
  return (
    <section data-testid="teams-view">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: spacing.gapMd }}>
        {teams.map((t) => (
          <div key={t.team_number} data-testid={`team-card-${t.team_number}`} style={teamCard}>
            <div style={{ fontWeight: 700, marginBottom: spacing.gapTiny }}>Team {t.team_number}</div>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: colors.textSecondary, fontSize: '0.9rem' }}>
              {t.members.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── View 5: Quiz Results — not a market callable; the classroom holds the KC scores. ──
function QuizView() {
  return (
    <section data-testid="quiz-view">
      <div style={teamCard}>
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Quiz results live in the classroom</h2>
        <p style={{ color: colors.textSecondary, lineHeight: 1.6 }}>
          Knowledge-check scores are recorded and reported by the classroom, not the market. Open the classroom to review them per student.
        </p>
        <a href={CLASSROOM_URL} target="_blank" rel="noreferrer" data-testid="quiz-classroom-link"
          style={{ display: 'inline-block', padding: `${spacing.gapSm} ${spacing.gapMd}`, background: '#D38626', color: '#fff', borderRadius: 6, textDecoration: 'none', fontWeight: 600 }}>
          Open the classroom →
        </a>
      </div>
    </section>
  )
}

function Stat({ label, value, testid, hint }: { label: string; value: string; testid: string; hint?: string }) {
  return (
    <div style={statBox} data-testid={testid}>
      <div style={{ fontSize: '0.78rem', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
      {hint && <div style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

const shell: CSSProperties = { padding: layout.pagePad, maxWidth: layout.maxWidth, margin: '0 auto', fontFamily: typography.fontFamily }
const navBar: CSSProperties = { display: 'flex', gap: '0.25rem', borderBottom: '2px solid #e2e6ea', flexWrap: 'wrap' }
const navIdle: CSSProperties = { padding: '0.5rem 0.9rem', border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: colors.textSecondary, borderBottom: '2px solid transparent', marginBottom: '-2px' }
const navActive: CSSProperties = { ...navIdle, color: '#111', fontWeight: 700, borderBottom: '2px solid #D38626' }
const statBox: CSSProperties = { flex: '1 1 180px', minWidth: 160, padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd' }
const teamCard: CSSProperties = { padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd' }
const th: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', background: '#f6f8fa', textAlign: 'right' }
const td: CSSProperties = { border: '1px solid #d0d7de', padding: '0.4rem 0.6rem', textAlign: 'right' }
