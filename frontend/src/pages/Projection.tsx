import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { getTransactionGraph, type TransactionGraph as TxGraph } from '../api'
import type { LicenseDoc } from '../market/shared'
import { clock } from '../market/shared'
import OwnershipBoard from '../market/OwnershipBoard'
import TransactionGraph from '../market/TransactionGraph'
import { useInstructorSession } from '../hooks/useInstructorSession'

// ── Full-screen PROJECTION surface (dry-run projection feature) ───────────────────────
// Opened in a SEPARATE window from the /market dashboard (via the "Project" buttons), reusing the
// attendance-code projection mechanism (window.open, room-sized). Renders the LIVE ownership board
// or transaction graph — the SAME onSnapshot(licenses) / getTransactionGraph poll the dashboard
// uses — big and legible from the back of a room, WITHOUT taking over the instructor's dashboard.
// The board especially was too small in the dry run, so it is zoomed up on a light panel.

const ms = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function'
    ? (v as { toMillis: () => number }).toMillis()
    : typeof v === 'number' ? v : null

export default function Projection() {
  const [searchParams] = useSearchParams()
  const view = searchParams.get('view') === 'graph' ? 'graph' : 'ownership'
  const { status: session, gameInstanceId, error } = useInstructorSession()

  if (session !== 'ready' || !gameInstanceId) {
    return (
      <main style={{ ...frame, alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: session === 'error' ? '#ff8a80' : '#bbb', fontSize: '1.6rem' }}>
          {session === 'error' ? (error ?? 'Could not open the projection.') : 'Setting up projection…'}
        </p>
      </main>
    )
  }
  return <ProjectionSurface gameInstanceId={gameInstanceId} view={view} />
}

function ProjectionSurface({ gameInstanceId, view }: { gameInstanceId: string; view: 'ownership' | 'graph' }) {
  const [now, setNow] = useState(() => Date.now())
  const [market, setMarket] = useState<{ status?: string; closes_at?: number | null } | null>(null)
  const [licenses, setLicenses] = useState<LicenseDoc[]>([])
  const [graph, setGraph] = useState<TxGraph | null>(null)

  // Same live sources as the dashboard — ownership rides onSnapshot, the graph rides the 5s poll.
  useEffect(() => onSnapshot(doc(db, 'game_instances', gameInstanceId, 'market', 'state'), (s) => {
    const d = (s.data() ?? {}) as Record<string, unknown>
    setMarket({ status: d['status'] as string | undefined, closes_at: ms(d['closes_at']) })
  }), [gameInstanceId])
  useEffect(() => onSnapshot(collection(db, 'game_instances', gameInstanceId, 'licenses'),
    (s) => setLicenses(s.docs.map((d) => d.data() as LicenseDoc))), [gameInstanceId])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    if (view !== 'graph') return
    const refresh = () => getTransactionGraph().then(setGraph).catch(() => { /* transient — retried */ })
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [view])

  const timeLeft = market?.closes_at ? market.closes_at - now : null
  const deadlinePassed = timeLeft != null && timeLeft <= 0
  const open = market?.status === 'open' && !deadlinePassed
  const clockText = (market?.status === 'closed' || deadlinePassed) ? 'Market closed'
    : open ? `● Market open${timeLeft != null ? ` · ${clock(timeLeft)} left` : ''}`
    : 'Waiting for the market to open'

  return (
    <main style={frame} data-testid="projection">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0.7rem 1.4rem', flexShrink: 0, gap: '1rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '2rem', color: '#fff', letterSpacing: '0.01em' }}>
          Spectrum — {view === 'graph' ? 'Transaction Graph' : 'Ownership'}
        </h1>
        <span data-testid="projection-clock" style={{ fontSize: '1.4rem', fontWeight: 700, color: open ? '#66ff9c' : '#cfcfcf' }}>{clockText}</span>
      </header>
      <div style={view === 'ownership' ? boardPanel : panel}>
        {view === 'ownership'
          ? <FillToWindow><OwnershipBoard licenses={licenses} title="Ownership" /></FillToWindow>
          : graph
            ? <TransactionGraph points={graph.points} openedAt={graph.opened_at} closesAt={graph.closes_at} />
            : <p style={{ color: '#888', fontSize: '1.3rem' }}>Loading…</p>}
      </div>
    </main>
  )
}

// ── FillToWindow — scale the board up to FILL the projection window (item 3). The board is a
// fixed-size table; here we measure its natural size and the panel, then transform-scale it as
// large as fits (centered), so the projection is dominated by the board, not white space —
// legible from the back of a room. offsetWidth/Height ignore the transform, so there is no
// measure↔scale feedback loop; a ResizeObserver re-fits on window resize or board growth. ─────
function FillToWindow({ children }: { children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const outer = outerRef.current, inner = innerRef.current
    if (!outer || !inner) return
    const fit = () => {
      const nw = inner.offsetWidth, nh = inner.offsetHeight
      if (!nw || !nh) return
      const k = Math.min(outer.clientWidth / nw, outer.clientHeight / nh)
      if (Number.isFinite(k) && k > 0) setScale(k * 0.97) // small margin off the edges
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(outer); ro.observe(inner)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={outerRef} data-testid="projection-fill" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div ref={innerRef} style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) scale(${scale})`, transformOrigin: 'center center' }}>
        {children}
      </div>
    </div>
  )
}

const frame: CSSProperties = { minHeight: '100vh', background: '#111', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }
const panel: CSSProperties = { flex: 1, background: '#fff', margin: '0 1rem 1rem', borderRadius: 8, padding: '1.5rem', overflow: 'auto' }
// The ownership board fills its panel (FillToWindow is absolutely positioned) — no inner padding
// so the scaled board can use the whole surface; position relative anchors the absolute fill.
const boardPanel: CSSProperties = { flex: 1, background: '#fff', margin: '0 1rem 1rem', borderRadius: 8, position: 'relative', overflow: 'hidden' }
