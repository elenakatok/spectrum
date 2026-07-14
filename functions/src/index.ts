import { onRequest } from 'firebase-functions/v2/https'
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
  makeTriggerMatching,
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
export const triggerMatching            = makeTriggerMatching(spectrumGameDef)
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
export { seedMatchTest, seedGroupForTest } from './seedFunctions'
