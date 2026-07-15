import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { colors, layout, spacing, typography } from '@mygames/game-ui'
import { getTeamState, getAuctionState, type TeamState, type AuctionState } from '../api'
import type { LicenseDoc, RegionSchedule } from '../market/shared'
import { clock } from '../market/shared'
import OwnershipBoard from '../market/OwnershipBoard'
import GeneralTab from '../market/GeneralTab'
import TeamsTab from '../market/TeamsTab'
import TransactionsTab from '../market/TransactionsTab'
import HistoryTab from '../market/HistoryTab'

// ── Spectrum MarketRoom (Slice 3) — the five-tab student market. ───────────────────────
// Live public data (ownership board, market clock, active-auction discovery) comes straight
// from the rules-allowed collections via onSnapshot; team-PRIVATE data (cash/available/
// portfolio, own history, roster names) comes ONLY through the Slice-3 read callables. No
// other team's private data is ever fetched — the privacy walk asserts this end-to-end.

type ParticipantDoc = {
  team_number?: number
  team_password?: string
  team_synergy?: RegionSchedule[]
  team_endowment_regions?: string[]
  group_id?: string
  // Opening snapshot stamped at grouping — used as the INSTANT initial value for the stat
  // tiles until getTeamState resolves with the live figures (which stay fresh after trades).
  team_cash?: number
  team_license_value?: number
  team_portfolio_value?: number
  team_license_ids?: string[]
}
type MarketDoc = { status?: string; opened_at?: number | null; closes_at?: number | null }

type Tab = 'general' | 'ownership' | 'teams' | 'transactions' | 'history'
const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'teams', label: 'Teams' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'history', label: 'History' },
]

export default function MarketRoom({ participantId, gameInstanceId }: { participantId: string; gameInstanceId: string }) {
  const [me, setMe] = useState<ParticipantDoc | null>(null)
  const [licenses, setLicenses] = useState<LicenseDoc[]>([])
  const [market, setMarket] = useState<MarketDoc | null>(null)
  const [teamState, setTeamState] = useState<TeamState | null>(null)
  const [openAuctions, setOpenAuctions] = useState<AuctionState[]>([])
  const [tab, setTab] = useState<Tab>('general')
  const [now, setNow] = useState(() => Date.now())

  const inst = (sub: string) => collection(db, 'game_instances', gameInstanceId, sub)

  // ── Own participant doc (identity + password + synergy; static after grouping) ──
  useEffect(() => onSnapshot(doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
    (s) => setMe((s.data() ?? {}) as ParticipantDoc)), [participantId, gameInstanceId])

  // ── Public live collections: licenses (ownership + auction discovery) + market clock ──
  useEffect(() => onSnapshot(inst('licenses'),
    (s) => setLicenses(s.docs.map((d) => d.data() as LicenseDoc))), [gameInstanceId])
  useEffect(() => onSnapshot(doc(db, 'game_instances', gameInstanceId, 'market', 'state'), (s) => {
    // opened_at/closes_at are stored as Firestore Timestamps; the clock + History elapsed need
    // millis. (getMarketState converts for its own callers, but we read the raw doc here.)
    const d = (s.data() ?? {}) as Record<string, unknown>
    const ms = (v: unknown): number | null =>
      v && typeof (v as { toMillis?: () => number }).toMillis === 'function'
        ? (v as { toMillis: () => number }).toMillis()
        : typeof v === 'number' ? v : null
    setMarket({ status: d['status'] as string | undefined, opened_at: ms(d['opened_at']), closes_at: ms(d['closes_at']) })
  }), [gameInstanceId])

  // ── 1-second clock tick (display only) ──
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])

  const myTeam = me?.team_number ?? null

  // ── Team-private state (getTeamState): poll + refresh-on-action ──
  const refreshTeamState = useCallback(() => {
    if (myTeam == null) return
    getTeamState().then(setTeamState).catch(() => { /* transient — retried on interval */ })
  }, [myTeam])
  useEffect(() => {
    if (myTeam == null) return
    refreshTeamState()
    const id = setInterval(refreshTeamState, 8000)
    return () => clearInterval(id)
  }, [myTeam, refreshTeamState])

  // ── Active auctions: discovered from the PUBLIC license lock (under_auction), then each
  //    one's public state fetched via getAuctionState. Polled; also refreshed on action. ──
  const auctionIds = useMemo(
    () => [...new Set(licenses.map((l) => l.under_auction).filter((x): x is string => !!x))].sort(),
    [licenses],
  )
  const auctionIdsKey = auctionIds.join(',')
  const auctionIdsRef = useRef<string[]>([])
  auctionIdsRef.current = auctionIds
  const refreshAuctions = useCallback(() => {
    const ids = auctionIdsRef.current
    if (myTeam == null || ids.length === 0) { setOpenAuctions([]); return }
    Promise.all(ids.map((id) => getAuctionState(id).catch(() => null)))
      .then((rs) => setOpenAuctions(rs.filter((r): r is AuctionState => !!r && r.status === 'open')))
  }, [myTeam])
  useEffect(() => {
    refreshAuctions()
    const id = setInterval(refreshAuctions, 5000)
    return () => clearInterval(id)
  }, [auctionIdsKey, refreshAuctions])

  const onActed = useCallback(() => { refreshTeamState(); refreshAuctions() }, [refreshTeamState, refreshAuctions])

  // ── Derived: my live holdings by region + all regions ──
  const holdings = useMemo(() => {
    if (myTeam == null) return []
    const byRegion = new Map<string, number>()
    for (const l of licenses) if (l.owner_team === myTeam && l.under_auction == null) byRegion.set(l.region, (byRegion.get(l.region) ?? 0) + 1)
    return [...byRegion.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([region, count]) => ({ region, count }))
  }, [licenses, myTeam])
  const allRegions = useMemo(
    () => [...new Set(licenses.map((l) => l.region))].sort((a, b) => a.localeCompare(b)),
    [licenses],
  )

  const status = market?.status ?? 'grouped'
  const marketOpen = status === 'open'
  const timeLeft = market?.closes_at ? market.closes_at - now : null

  // Effective team state: live getTeamState once loaded, else the participant-doc opening
  // snapshot (instant, correct until the first trade — then getTeamState takes over).
  const liveState = teamState ?? (myTeam != null && me ? {
    ok: true, team_number: myTeam,
    cash: me.team_cash ?? 0, escrowed: 0, available: me.team_cash ?? 0,
    license_ids: me.team_license_ids ?? [],
    license_value: me.team_license_value ?? 0,
    portfolio_value: me.team_portfolio_value ?? 0,
  } : null)

  // Not yet stamped onto a team (between the two instructor buttons).
  if (myTeam == null) {
    return (
      <main style={shell}>
        <h1 style={{ marginTop: 0 }}>You&apos;re in the market</h1>
        <p style={{ lineHeight: 1.6, color: colors.textSecondary }}>
          Your team and portfolio will appear the moment your instructor groups the room — stay on this page.
        </p>
      </main>
    )
  }

  return (
    <main style={shell} data-testid="market-room">
      {/* Header: identity + market clock/status */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.gapMd, marginBottom: spacing.gapSm }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Spectrum — Team {myTeam}</h1>
        <div style={{ fontSize: '0.9rem', color: marketOpen ? '#137333' : colors.textSecondary, fontWeight: 600 }} data-testid="market-clock">
          {status === 'closed' ? 'Market closed'
            : marketOpen ? `● Market open${timeLeft != null ? ` · ${clock(timeLeft)} left` : ''}`
            : 'Waiting for the market to open'}
        </div>
      </div>

      {/* Tab bar */}
      <div role="tablist" style={tabBar}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`tab-${t.key}`}
            onClick={() => setTab(t.key)} style={tab === t.key ? tabActive : tabIdle}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ paddingTop: spacing.gapMd }}>
        {tab === 'general' && (
          <GeneralTab
            teamNumber={myTeam}
            teamPassword={me?.team_password ?? ''}
            synergy={me?.team_synergy ?? []}
            endowmentRegions={me?.team_endowment_regions ?? []}
            teamState={liveState}
            holdings={holdings}
            openAuctions={openAuctions}
            myTeam={myTeam}
            onActed={onActed}
          />
        )}
        {tab === 'ownership' && <OwnershipBoard licenses={licenses} myTeam={myTeam} />}
        {tab === 'teams' && <TeamsTab myTeam={myTeam} />}
        {tab === 'transactions' && (
          <TransactionsTab
            myHoldings={holdings}
            allRegions={allRegions}
            available={liveState?.available ?? 0}
            marketOpen={marketOpen}
            onActed={onActed}
          />
        )}
        {tab === 'history' && <HistoryTab myTeam={myTeam} openedAt={market?.opened_at ?? null} />}
      </div>
    </main>
  )
}

const shell: CSSProperties = { padding: layout.pagePad, maxWidth: layout.maxWidth, margin: '0 auto', fontFamily: typography.fontFamily }
const tabBar: CSSProperties = { display: 'flex', gap: '0.25rem', borderBottom: '2px solid #e2e6ea', flexWrap: 'wrap' }
const tabIdle: CSSProperties = { padding: '0.5rem 0.9rem', border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: colors.textSecondary, borderBottom: '2px solid transparent', marginBottom: '-2px' }
const tabActive: CSSProperties = { ...tabIdle, color: '#111', fontWeight: 700, borderBottom: '2px solid #D38626' }
