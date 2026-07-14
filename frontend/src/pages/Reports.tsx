import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  ReportBoard,
  GameHeader,
  ExportModal,
  buildStudentTextExport,
  type SortableColumn,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import type { ReportData, StudentReportRow } from '../api'

// PHASE A SKELETON. Per-student participation + KC + free-text tiles only. The full
// market reports (leaderboard, transaction history, price-over-time) land in Slice 7.

// ── Formatting ──────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = { trader: 'Trader' }

const fmtKc = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`

// ── Per-student report (participation + KC are the grade) ─────────────────────────

type StudentSortKey = 'name' | 'group' | 'role' | 'participation' | 'kc'

const STUDENT_COLUMNS: readonly SortableColumn<StudentReportRow, StudentSortKey>[] = [
  { key: 'name', label: 'Name', sticky: 'left', headerStyle: { minWidth: 140 },
    render: r => r.display_name, compare: (a, b) => a.display_name.localeCompare(b.display_name) },
  { key: 'group', label: 'Group #',
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

// ── Page ────────────────────────────────────────────────────────────────────────

type ReportKind = 'student'

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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true); setError(null)
    const fn = httpsCallable<object, ReportData>(functions, 'getReportData')
    fn({}).then(r => { setData(r.data); setLoading(false) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Failed to load report data.'); setLoading(false) })
  }, [sessionReady])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [activeExport, setActiveExport] = useState<{ title: string; text: string } | null>(null)

  const rows = data?.rows ?? []
  const questions = data?.questions ?? []

  const tiles: ReportTileConfig[] = [
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
        <ReportBoard tiles={tiles} />
      </main>

      {/* Per-student report */}
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
