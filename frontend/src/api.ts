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

// PHASE A SKELETON: the live trading market (deals, swaps, auctions) is DELIBERATELY
// ABSENT — it arrives in Slices 1–5 (Spectrum_Build_Plan_v1.md). No market callables here.

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
