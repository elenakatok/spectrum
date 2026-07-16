import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { InstructorDashboard as SharedDashboard } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { spectrumConfig } from '../gameConfig'
import { groupParticipants, startMarket, endMarket, getMarketState, getLeaderboard, type MarketState } from '../api'

const roleLabels = Object.fromEntries(
  spectrumConfig.roles.map(r => [r.key, r.label])
)

// ── Spectrum GROUPING PANEL (Slice 0) ─────────────────────────────────────────────
// Spectrum forms teams via an instructor-driven, TWO-STEP flow (v3 §9.1 + Slice 0
// addenda) that REPLACES the shared rolling matcher:
//   1. type N (even, 14–26) → Set Number of Teams → Group Participants  (status 'grouped')
//   2. Start Market  (status 'open', clock starts)
//
// The shared dashboard has no injection slot and its "Match Now" button is hardwired to
// the rolling matcher — which for Spectrum is WRONG (random {trader:4} groups, no
// synergies). So, exactly like eBay's auction strip, this panel PORTALS its controls into
// the shared <main> (below the button bar, above the roster) with ZERO shared-package
// change — and additionally HIDES the shared "Match Now" button so it can't be clicked.
// (Start Market lives in the same place eBay's "Start Auction" lives — the locked spec.)

const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')

// Tidy the shared dashboard to Spectrum's vocabulary WITHOUT a shared-package change —
// same DOM-patch pattern as eBay's auction strip. Re-applied on every poll tick so it
// survives the shared component's re-renders (sort, roster refresh):
//   1. hide "Match Now" — Spectrum groups via the panel above, not the rolling matcher;
//   2. hide the vestigial single-role "Show: Trader" roster filter (one role → nothing to filter);
//   3. "Teams" everywhere, never "Groups" (v3 §11 / Slice 3): relabel the roster "Group #" header;
//   4. Outcome column → live team Portfolio Value (dry-run item 9) when the leaderboard is loaded.
function tidySharedDashboard(board?: Map<number, number>) {
  for (const btn of Array.from(document.querySelectorAll('button'))) {
    const t = (btn.textContent ?? '').trim()
    if (t === 'Match Now' || t === 'Matching…') (btn as HTMLElement).style.display = 'none'
  }
  for (const span of Array.from(document.querySelectorAll('span'))) {
    if ((span.textContent ?? '').trim() === 'Show:') {
      const box = span.parentElement as HTMLElement | null
      if (box) box.style.display = 'none'
    }
  }
  for (const th of Array.from(document.querySelectorAll('th'))) {
    // {col.label} renders as its OWN text node, separate from the sort arrow — so
    // replacing just that node's text keeps the caret intact.
    for (const node of Array.from(th.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.includes('Group #')) {
        node.nodeValue = node.nodeValue.replace('Group #', 'Team #')
      }
    }
  }

  // 4. Outcome column → team Portfolio Value (dry-run item 9, Elena-approved local override).
  // The shared "Outcome" cell shows raw_score — Spectrum's FLAT participation grade (+1), which is
  // load-bearing for the gradebook (the playthrough asserts "value never graded"). So we NEVER touch
  // raw_score; we only REPAINT the displayed cell + header from getLeaderboard. Grades are unchanged.
  // Column order is fixed [name, role, status, Team#, Outcome] → Outcome is the LAST <td>, Team # the
  // one before it. Idempotent (writes only when the text differs → never retriggers the observer);
  // re-applied every tick/mutation so it survives the shared roster re-rendering the +1 back in.
  if (board && board.size) {
    const table = document.querySelector('[data-testid="roster-table"] table')
    if (table) {
      for (const th of Array.from(table.querySelectorAll('thead th'))) {
        for (const node of Array.from(th.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim() === 'Outcome') {
            node.nodeValue = 'Portfolio Value'
          }
        }
      }
      for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
        const tds = tr.querySelectorAll('td')
        if (tds.length < 2) continue
        const teamNum = parseInt(((tds[tds.length - 2].textContent ?? '').match(/\d+/) ?? [''])[0], 10)
        const pv = board.get(teamNum)
        if (!Number.isFinite(teamNum) || pv == null) continue
        const outCell = tds[tds.length - 1] as HTMLElement
        const target = (outCell.querySelector('span') ?? outCell) as HTMLElement
        const shown = '$' + Math.round(pv).toLocaleString('en-US')
        if (target.textContent !== shown) {
          target.textContent = shown
          target.style.color = '#333'   // undo the faint-null styling if the row had been "—"
        }
      }
    }
  }
}

// Live market progress (invariant 5): current value = Σ team portfolios; efficiency captured =
// how far the market has closed the gap from the initial allocation toward the efficient ceiling.
type Progress = { current: number; initial: number; efficient: number }
const efficiencyPct = (p: Progress) =>
  p.efficient > p.initial ? Math.round(((p.current - p.initial) / (p.efficient - p.initial)) * 100) : 0

function GroupingPanel() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [state, setState] = useState<MarketState | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [nInput, setNInput] = useState('20')
  const [nSet, setNSet] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // team_number → portfolio_value, from getLeaderboard — feeds the roster Outcome→Portfolio repaint
  // (item 9). A ref (not state) so the MutationObserver/tidy always read the latest without re-binding.
  const boardRef = useRef<Map<number, number>>(new Map())

  // Mount a host as the first child of the shared <main>; portal the strip into it.
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-spectrum-grouping-host', '')
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])

  // Keep the shared dashboard tidy on EVERY re-render, not just the 1.5s poll: the shared roster
  // re-renders on its own poll and React re-applies its inline style objects, which wiped the
  // 1.5s-tidy's display:none (Show: filter) and text relabel (Group # → Team #) between ticks —
  // the filter + old header visibly flashed back. A MutationObserver re-applies the tidy within a
  // frame of any DOM change. We observe childList/subtree only (not attributes/characterData) and
  // disconnect during the tidy, so the tidy's own style/text edits never retrigger it.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      obs.disconnect()
      tidySharedDashboard(boardRef.current)
      obs.observe(document.body, { childList: true, subtree: true })
    })
    tidySharedDashboard(boardRef.current)
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [])

  // Poll market state (drives button enablement) + keep the shared dashboard tidy.
  useEffect(() => {
    let alive = true
    const tick = () => {
      tidySharedDashboard(boardRef.current)
      getMarketState()
        .then(s => {
          if (!alive) return
          setState(s)
          // Once open, poll the live leaderboard for the current-value + efficiency readout
          // (same refresh cadence as the leaderboard view — invariant 5) AND the per-team portfolio
          // values that repaint the roster Outcome column (item 9).
          if (s.status === 'open' || s.status === 'closed') {
            getLeaderboard()
              .then(b => {
                if (!alive) return
                setProgress({ current: b.value_after_trade, initial: b.total_initial_value, efficient: b.efficient_market_value })
                boardRef.current = new Map(b.teams.map(t => [t.team_number, t.portfolio_value]))
                tidySharedDashboard(boardRef.current)   // repaint immediately with the fresh values
              })
              .catch(() => { /* transient — retried next tick */ })
          }
        })
        .catch(() => { /* session not ready yet — retry on the interval */ })
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const status = state?.status ?? 'setup'
  const grouped = status === 'grouped' || status === 'open' || status === 'closed'
  const open = status === 'open' || status === 'closed'

  const doSetN = () => {
    const n = Number(nInput)
    if (!Number.isInteger(n) || n % 2 !== 0 || n < 14 || n > 26) {
      setMsg('N must be an even number between 14 and 26.')
      return
    }
    setNSet(n)
    setMsg(`${n} teams set — press Group Participants.`)
  }

  const doGroup = () => {
    if (nSet == null) return
    setBusy(true); setMsg('Grouping…')
    groupParticipants(nSet)
      // NOTE: the efficient-market value is shown in the bold summary below — don't restate it here.
      .then(r => setMsg(
        r.alreadyGrouped
          ? `Already grouped: ${r.teams_created} teams.`
          : `Grouped ${r.teams_created} teams into ${r.num_regions} regions.`,
      ))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Grouping failed.'))
      .finally(() => setBusy(false))
  }

  const doStart = () => {
    setBusy(true); setMsg('Starting market…')
    startMarket()
      .then(r => setMsg(r.alreadyStarted ? 'Market already open.' : 'Market open — the clock is running.'))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Start failed.'))
      .finally(() => setBusy(false))
  }

  // End the market early (dry-run item 6) — reuses the hard-close path (server pulls closes_at to
  // now, freezing the ledger exactly like the clock). Irreversible, so confirm first.
  const doEnd = () => {
    if (!window.confirm('End the market now for everyone? Trading freezes immediately — exactly like the clock reaching the deadline. This cannot be undone.')) return
    setBusy(true); setMsg('Ending market…')
    endMarket()
      .then(r => setMsg(r.alreadyClosed ? 'Market already closed.' : 'Market ended — trading is frozen. Run the reports and Score & Record when ready.'))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'End failed.'))
      .finally(() => setBusy(false))
  }

  if (!host) return null

  return createPortal(
    <div
      data-testid="grouping-controls"
      style={{ margin: '0 0 1.5rem', padding: '0.75rem 1rem', border: '1px solid #d0d7de', borderRadius: 8, background: '#fbfcfd' }}
    >
      <div style={{ fontWeight: 700, marginBottom: '0.5rem', fontSize: '1.05rem' }}>
        Grouping &amp; market{' '}
        <span data-testid="market-status" style={{ fontWeight: 400, color: '#666', fontSize: '0.9rem' }}>
          — status: {status}
        </span>
      </div>

      {!grouped && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.9rem' }}>
            Number of teams (N):{' '}
            <input
              data-testid="num-teams-input"
              type="number" min={14} max={26} step={2}
              value={nInput}
              onChange={e => setNInput(e.target.value)}
              disabled={busy}
              style={{ width: 70, padding: '0.25rem 0.4rem' }}
            />
          </label>
          <button data-testid="set-num-teams" onClick={doSetN} disabled={busy}>Set Number of Teams</button>
          <button data-testid="group-participants" onClick={doGroup} disabled={busy || nSet == null}>
            Group Participants
          </button>
          <span style={{ fontSize: '0.85rem', color: '#888' }}>even, 14–26</span>
        </div>
      )}

      {grouped && !open && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.9rem' }}>
            {state?.num_teams} teams · {state?.num_regions} regions · Efficient Market Value{' '}
            <strong>{money(state?.efficient_market_value)}</strong>
          </span>
          <button data-testid="start-market" onClick={doStart} disabled={busy}>Start Market</button>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>students are reading their team dossiers</span>
        </div>
      )}

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.9rem', color: '#137333', fontWeight: 600 }}>
              ● Market open — {state?.num_teams} teams · {state?.num_regions} regions
              {state?.closes_at ? ` · closes at ${new Date(state.closes_at).toLocaleTimeString()}` : ''}
            </span>
            {/* The live projector dashboard is a separate route; carry the same launch token
                (?token=&game_instance_id= or the DEV bypass) straight through its query string. */}
            <a data-testid="open-live-market" href={`/market${window.location.search}`}
              style={{ fontSize: '0.9rem', fontWeight: 600, color: '#D38626' }}>
              Open live market dashboard →
            </a>
            {status === 'open' && (
              <button data-testid="end-market" onClick={doEnd} disabled={busy}
                style={{ fontSize: '0.85rem', color: '#8b1a1a', borderColor: '#e0b4b4', cursor: 'pointer' }}>
                End market now
              </button>
            )}
          </div>
          {/* Live progress — full efficiency numbers (dry-run item 10): current + efficient market
              value, plus the raw gains-captured / gains-available the % is computed from. 0% at open. */}
          <span data-testid="market-progress" style={{ fontSize: '0.9rem', color: '#555' }}>
            Current Market Value <strong>{money(progress?.current)}</strong>
            {' · '}Efficient Market Value <strong>{money(progress?.efficient)}</strong>
            {' · '}Efficiency captured <strong>{progress ? efficiencyPct(progress) : 0}%</strong>
            {progress && (
              <span style={{ color: '#888' }}>
                {' '}— gains captured {money(progress.current - progress.initial)} of {money(progress.efficient - progress.initial)} available
              </span>
            )}
          </span>
        </div>
      )}

      {msg && <div style={{ fontSize: '0.85rem', color: '#555', marginTop: '0.5rem' }}>{msg}</div>}
    </div>,
    host,
  )
}

export default function InstructorDashboard() {
  return (
    <>
      {/* Grouping + Start Market controls — portaled into the shared <main>; also hides
          the shared "Match Now" button (Spectrum groups via this panel). */}
      <GroupingPanel />
      <SharedDashboard
        title="Instructor Dashboard — Spectrum"
        roleLabels={roleLabels}
        composition={{ trader: 4 }}
        functions={functions}
        auth={auth}
        rtdb={rtdb}
        settingsRoute="/settings"
        reportsRoute="/reports"
        scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
      />
    </>
  )
}
