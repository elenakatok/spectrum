import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeStartNegotiation,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeSubmitInstructorOutcome,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  makeGetStudentPrepQuestions,
  makeGetDebriefQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
  makeGetInfoUrls,
} from '@mygames/game-server'
import { spectrumGameDef } from './gameDefinition'
import { makeGroupParticipants, makeStartMarket, makeGetMarketState } from './grouping'
import { makeExecuteDeal, makeExecuteSwap, makeSettleAuction } from './ledger'
import { makeCreateAuction, makePlaceBid, makeGetAuctionState, settleAuctionTask } from './auctionLifecycle'

admin.initializeApp()

// NOTE: Spectrum uses the single-role KC gate ('kc_gate_trader', grading 'assigned_role')
// plus PLACEHOLDER graded statics (Phase A stub — see gameDefinition prepDefaults; the
// FINAL KC content lands in Slice 6). The shared validateKCGate would PASS (exactly one
// gate covers the 'trader' role); validation runs at config-save time in makeUpdateGameConfig.
//
// PHASE A SKELETON: only the generic skeleton endpoints are wired. The trading market —
// ledger, swaps, auctions, endowment/synergy generation — is DELIBERATELY ABSENT and
// arrives in Slices 0–8 (Spectrum_Build_Plan_v1.md). No auction functions are exported.

// ── Game endpoints (onCall, via game-server factories + Spectrum definition) ─

export const getInstructorSession  = makeGetInstructorSession(spectrumGameDef)
export const assignRole             = makeAssignRole(spectrumGameDef)
export const completePrep           = makeCompletePrep(spectrumGameDef)
export const confirmReady           = makeConfirmReady(spectrumGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(spectrumGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(spectrumGameDef)
export const getRoster              = makeGetRoster(spectrumGameDef)
export const syncRoster             = makeSyncRoster(spectrumGameDef)
// ── Spectrum grouping (Slice 0) — REPLACES the shared rolling matcher ──────────
// Instructor-driven, two-step, two transactions (v3 §9.1 + Slice 0 addenda):
//   groupParticipants → partition N teams + generate synergies/endowments/passwords
//   startMarket       → open the market and start the clock
export const groupParticipants          = makeGroupParticipants(spectrumGameDef)
export const startMarket                = makeStartMarket(spectrumGameDef)
export const getMarketState             = makeGetMarketState(spectrumGameDef)

// ── Ledger core (Slice 1) — the three transactional market mutations ──────────
export const executeDeal                = makeExecuteDeal(spectrumGameDef)
export const executeSwap                = makeExecuteSwap(spectrumGameDef)
export const settleAuction              = makeSettleAuction(spectrumGameDef)

// ── Auction lifecycle (Slice 2) — create / bid / state + the Cloud Task close ─
export const createAuction              = makeCreateAuction(spectrumGameDef)
export const placeBid                   = makePlaceBid(spectrumGameDef)
export const getAuctionState            = makeGetAuctionState(spectrumGameDef)
export { settleAuctionTask }

// Guard: the shared dashboard's "Match Now" button is hidden by the Spectrum grouping
// panel, but if it is ever reached it must NOT run the rolling matcher (which would tile
// random {trader:4} groups with no synergies). Fail loud, pointing to the right flow.
export const triggerMatching = onCall({ cors: spectrumGameDef.corsOrigins }, async () => {
  throw new HttpsError(
    'failed-precondition',
    'Spectrum forms teams via the instructor "Group Participants" button, not "Match Now".',
  )
})
export const startNegotiation           = makeStartNegotiation(spectrumGameDef)
export const submitLeadOutcome          = makeSubmitLeadOutcome(spectrumGameDef)
export const submitConfirmation         = makeSubmitConfirmation(spectrumGameDef)
export const submitInstructorOutcome    = makeSubmitInstructorOutcome(spectrumGameDef)
export const finalizeInstance       = makeFinalizeInstance(spectrumGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(spectrumGameDef)
export const getGameConfig          = makeGetGameConfig(spectrumGameDef)
export const updateGameConfig       = makeUpdateGameConfig(spectrumGameDef)
export const getStudentPrepQuestions            = makeGetStudentPrepQuestions(spectrumGameDef)
export const getDebriefQuestions                = makeGetDebriefQuestions(spectrumGameDef)
export const submitKnowledgeCheck               = makeSubmitKnowledgeCheck(spectrumGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(spectrumGameDef)
export const getInfoUrls                        = makeGetInfoUrls(spectrumGameDef)
export { getReportData } from './getReportData'
export { scoreAndRecord } from './scoreAndRecord'

// ── Non-game onRequest endpoints ──────────────────────────────────────────────

const CORS_ORIGINS = new Set(['https://spectrum.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'spectrum' })
})

// Emulator-only dev seed functions — onRequest, not game endpoints.
export { seedMatchTest, seedGroupForTest, seedLedgerTest } from './seedFunctions'
