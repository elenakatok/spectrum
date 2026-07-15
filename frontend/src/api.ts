import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'

// ── Helper ────────────────────────────────────────────────────────────────────
// Single wrapper: the Firebase SDK auto-attaches the ID token Bearer when
// auth.currentUser exists, and sends nothing when there is no session —
// covering both bootstrap (getInstructorSession, assignRole) and authed calls.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestArgs   = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs  = { token: string }
export type BearerArgs = Record<string, never>   // empty — auth is in Authorization header
export type CallArgs   = TestArgs | TokenArgs | BearerArgs

export type AssignRoleResult = {
  ok:               boolean
  role:             string
  customToken:      string
  participant_id:   string
  game_instance_id: string
}

/** Bootstrap — no session yet; classroom JWT or _test bypass travels in data. */
export const assignRole = (args: CallArgs) =>
  callFn<AssignRoleResult>('assignRole', args)

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

// onCall auth errors arrive as FirebaseError with code 'functions/permission-denied'
// or 'functions/unauthenticated' — not HTTP status strings.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}

export type OutcomeFields = Record<string, unknown>

export const confirmReady = (args: CallArgs) =>
  callFn<{ ok: boolean }>('confirmReady', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFn<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

export const startNegotiation = (args: CallArgs) =>
  callFn<{ ok: boolean }>('startNegotiation', args)

export const submitLeadOutcome = (args: CallArgs, outcome: OutcomeFields | null) =>
  callFn<{ ok: boolean }>('submitLeadOutcome', { ...args, outcome })

export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFn<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

// ── Market actions (Slices 1–2) — SDK auto-attaches the student Firebase Bearer ──────
// Payload only; the Firebase SDK attaches the ID token. Errors arrive as FirebaseError
// whose .message is the server's deliberately non-leaking text — surface it verbatim.

export const executeDeal = (p: {
  region: string; quantity: number; price: number; buyerTeam: number; buyerPassword: string
}) => callFn<{ ok: boolean; transaction_id: string; moved: string[] }>('executeDeal', p)

export const executeSwap = (p: {
  regionX: string; quantityX: number; regionY: string; quantityY: number; partnerTeam: number; partnerPassword: string
}) => callFn<{ ok: boolean; transaction_id: string; gave: string[]; got: string[] }>('executeSwap', p)

export const createAuction = (p: { region: string; quantity: number; reserve: number }) =>
  callFn<{ ok: boolean; auction_id: string; ends_at: number }>('createAuction', p)

export const placeBid = (p: { auction_id: string; amount: number }) =>
  callFn<{ ok: boolean; auction_id: string; amount: number }>('placeBid', p)

export type AuctionState = {
  ok: boolean
  auction_id: string
  region: string
  quantity: number
  seller_team: number
  status: 'open' | 'settled' | 'no_sale' | string
  time_remaining_ms: number
  your_bid?: number
  your_available_cash?: number
  clearing_price?: number | null
  you_won?: boolean
}
export const getAuctionState = (auctionId: string) =>
  callFn<AuctionState>('getAuctionState', { auction_id: auctionId })

// ── Student read-paths (Slice 3) — own team-private data + the names roster ──────────

export type TeamState = {
  ok: boolean
  team_number: number
  cash: number
  escrowed: number
  available: number
  license_ids: string[]
  license_value: number
  portfolio_value: number
}
export const getTeamState = () => callFn<TeamState>('getTeamState', {})

export type HistoryRow = {
  transaction_id: string
  type: 'deal' | 'swap' | 'auction' | string
  from_team: number | null
  to_team: number | null
  region: string | null
  quantity: number | null
  region_x: string | null
  quantity_x: number | null
  region_y: string | null
  quantity_y: number | null
  price: number | null
  at: number | null
}
export const getTeamHistory = () =>
  callFn<{ ok: boolean; team_number: number; rows: HistoryRow[] }>('getTeamHistory', {})

export type TeamDirectoryEntry = { team_number: number; member_names: string[] }
export const getTeamsDirectory = () =>
  callFn<{ ok: boolean; teams: TeamDirectoryEntry[] }>('getTeamsDirectory', {})

// ── Instructor read-paths (Slice 4) — the dashboard's five views ─────────────────────
// SDK auto-attaches the instructor Firebase Bearer once the dashboard session exists. These
// two are the only reads that expose data across ALL teams — instructor-authed by design.

export type LeaderboardTeam = {
  team_number: number
  cash: number
  license_value: number
  portfolio_value: number
}
export type Leaderboard = {
  ok: boolean
  teams: LeaderboardTeam[]        // ranked by portfolio_value, descending
  value_after_trade: number       // Σ portfolio across teams
  total_initial_value: number
  efficient_market_value: number
}
export const getLeaderboard = () => callFn<Leaderboard>('getLeaderboard', {})

export type GraphPoint = {
  type: 'deal' | 'swap' | 'auction' | string
  region: string | null
  quantity: number | null
  price: number | null
  price_per_license: number | null   // null for swaps (drawn on a price-less strip)
  at_ms: number | null
}
export type TransactionGraph = {
  ok: boolean
  opened_at: number | null
  points: GraphPoint[]
}
export const getTransactionGraph = () => callFn<TransactionGraph>('getTransactionGraph', {})

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type RosterParticipant = {
  participant_id: string
  display_name:   string
  role:           string | null
  role_label:     string | null
  group_id:       string | null
  is_lead:        boolean | null
  attended:       boolean
  finalized:      boolean
}

export type RosterGroup = {
  group_id:             string
  status:               string
  lead_participant_id:  string
  participants_by_role: Record<string, string[]>
  agreement_reached:    boolean | null
  outcome:              Record<string, unknown> | null
}

export type PushSummary = {
  total:     number
  succeeded: number
  failed:    { participant_id: string; reason: string }[]
}

/** Bootstrap — no session yet; JWT travels in data; SDK attaches nothing. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** Remaining instructor calls: SDK auto-attaches Firebase Bearer when session exists. */
export const syncRoster = () =>
  callFn<{ ok: boolean; synced: number; skipped: number }>('syncRoster', {})

export const generateAttendanceCode = () =>
  callFn<{ ok: boolean; code: string }>('generateAttendanceCode', {})

export const getRoster = () =>
  callFn<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[] }>('getRoster', {})

// ── Spectrum grouping (Slice 0) — instructor two-step flow ────────────────────
// Replaces the shared rolling matcher. Auth travels as the instructor Bearer token
// (SDK auto-attaches once the dashboard session is established) — no gid on the client.

export type GroupParticipantsResult = {
  ok: boolean
  num_teams: number
  num_regions: number
  teams_created: number
  efficient_market_value: number | null
  alreadyGrouped?: boolean
}

export type MarketState = {
  ok: boolean
  status: 'setup' | 'grouped' | 'open' | 'closed' | string
  num_teams?: number | null
  num_regions?: number | null
  efficient_market_value?: number | null
  total_initial_value?: number | null
  opened_at?: number | null
  closes_at?: number | null
}

export const groupParticipants = (numTeams: number) =>
  callFn<GroupParticipantsResult>('groupParticipants', { num_teams: numTeams })

export const startMarket = () =>
  callFn<{ ok: boolean; alreadyStarted: boolean; opened_at: number | null; closes_at: number | null }>('startMarket', {})

export const getMarketState = () =>
  callFn<MarketState>('getMarketState', {})

export const finalizeInstance = () =>
  callFn<{ ok: boolean }>('finalizeInstance', {})

// ── Reports (skeleton — mirrors functions/src/getReportData.ts) ───────────────────
// PHASE A: per-student participation + KC + free-text only. The full market reports
// (leaderboard, transaction history, price-over-time) land in Slice 7.

export type StudentReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  participation: number | null
  knowledge_check_score: number | null
  text_answers: Record<string, string>
}

export type ReportQuestion = { field: string; prompt: string; role_target: string }

export type ReportData = {
  ok: boolean
  rows: StudentReportRow[]
  questions: ReportQuestion[]
}

export const getReportData = () => callFn<ReportData>('getReportData', {})

export const pushResultsToClassroom = () =>
  callFn<{ ok: boolean } & PushSummary>('pushResultsToClassroom', {})
