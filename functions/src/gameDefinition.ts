import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// Spectrum — SINGLE-ROLE game. PHASE A SKELETON (blank canvas).
//
// There is ONE role: `trader` (single-role market, like eBay). Everything specific
// to the spectrum-trading market — the team model (instructor-set N teams 14–26 of
// shared portfolios), synergy maps, endowments, the ledger, auctions, swaps, and the
// market clock — is DELIBERATELY ABSENT in Phase A. It arrives in Slices 0–8
// (Spectrum_Build_Plan_v1.md). This file is scaffolding that proves the generic
// skeleton stands up on Spectrum's identity and pushes a placeholder grade end-to-end.
//
// PLACEHOLDER — replaced in later slices:
//   • composition { trader: 4 } — scaffolding only. Slice 0 replaces this with the
//     real team model (individual logins mapped to N shared team portfolios).
//   • outcomeSchema — one dummy field. Slices 1–5 replace the whole outcome phase
//     with the live trading market.
//   • computeScoreBreakdown / computeRawScore — flat participation stub. Real grading
//     (participation + KC only; PORTFOLIO VALUE NEVER GRADED) is finalized in Slice 6.
//   • prepDefaults — a single-option role gate + STUB KC questions. The FINAL KC
//     content (Spectrum_KC_Questions_v2.md) lands in Slice 6 with its four-function
//     deploy — it is intentionally NOT wired here.
//
// GRADING MODEL (context, not fully built in Phase A): attendance/participation + KC
// only; a team's portfolio value is NEVER graded. The skeleton uses the eBay
// participation stub — every present trader earns a flat participation point, so the
// single-role z-score pool is intentionally DEGENERATE (sample SD 0 → every present
// student normalizes to 0); true no-shows are handled by the engine (no_show → −2).
//
// KC GATE: the shared single-option gate ("What is your role in this market?" →
// "Trader") — the designed escape hatch for single-role games. The shared KC flow is
// gate-driven at both ends (the KnowledgeCheck UI needs a gate question to render; the
// graded-static submit needs the gate's completed_at marker), so the gate is REQUIRED
// to grade — no shared-package change, no participant preset, no KnowledgeCheck.tsx edit.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Role config (ONE role — `trader`) ─────────────────────────────────────────

export const spectrumConfig: RoleConfig = {
  roles: [
    { key: 'trader', label: 'Trader', short: 'T' },
  ],
}

// ── Outcome schema (PLACEHOLDER — one dummy field; replaced by the trading market) ──
// Ignored by scoring (participation-only). Present so finalize/report plumbing has a
// schema; Slices 1–5 replace the outcome phase entirely.
export const spectrumSchema: OutcomeSchema = [
  { key: 'placeholder', type: 'decimal', min: 0, max: 1_000_000, step: 1 },
]

// ── Score sense (value-sense; real scoring in Slice 6) ────────────────────────

export const spectrumScoreSense: Record<string, 'value' | 'cost'> = {
  trader: 'value',
}

// ── Scoring (PHASE A — PARTICIPATION only; portfolio value NEVER graded) ───────
// Every PRESENT trader earns the SAME flat participation point (1), independent of any
// outcome. Deliberate (grading model): participation + KC only. Consequences, intended:
//   • The single-role z-score pool is DEGENERATE — every present raw is identical, so
//     sample SD = 0 and the engine's zero-SD guard normalizes every present student to 0.
//   • A matched student who does nothing else is PRESENT (scores 1). A true no-show (no
//     role / never matched) is handled by the engine (status no_show → raw null, z = −2).
// The `outcome` argument is intentionally ignored — reading portfolio value out of it
// would be exactly the leak the grading model forbids.

export function computeScoreBreakdown(
  roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  // Flat participation point for every present trader — outcome-independent by design.
  if (roleKey === 'trader') return { value_or_cost: 1, raw_score: 1 }
  return { value_or_cost: 0, raw_score: 0 }
}

export function computeRawScore(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score
}

// ── GameDefinition ────────────────────────────────────────────────────────────

export const spectrumGameDef: GameDefinition = {
  game_id: 'spectrum',
  roles:   spectrumConfig,
  scoreSense: spectrumScoreSense,
  // composition is now VESTIGIAL for grouping: Slice 0 replaced the shared rolling
  // matcher with the instructor-driven `groupParticipants` callable (N teams, variable
  // size). It is retained only because the shared roster/scoring pipeline reads it for
  // single-role z-pooling; it no longer governs how teams are formed.
  composition: { trader: 4 },
  outcomeSchema: spectrumSchema,
  computeRawScore,
  computeScoreBreakdown,
  // reservations: PLACEHOLDER — real values arrive with scoring in Slice 6.
  reservations: { trader: 0 },
  corsOrigins: ['https://spectrum.mygames.live'],
  classroom: { callbackSecretId: 'spectrum_v1' },

  // Single-role sizing: base group {trader:4}; perRoleCap 7 lets one group absorb the
  // remainder up to size 7 (shared matcher tiling: 6→[6], 7→[7], 11→[6,5], 9→[5,4]).
  // PLACEHOLDER — the real team model (N instructor-set teams) supersedes this in Slice 0.
  perRoleCap: 7,
  // deadlockThreshold omitted → 5

  // Settings page config fields (ONE role — `trader`). PLACEHOLDER defaults.
  // Market parameters are stored as config data objects (NOT inline constants) so the
  // future admin-defaults screen stays a small addition. N (numTeams) is NOT here — it
  // is chosen on the instructor dashboard at grouping time (v3 §1, Slice 0 §2).
  configFields: [
    { key: 'trader_role_name', kind: 'string', default: 'Trader' },
    // ONE shared case/instructions PDF placeholder. Real role material arrives later.
    { key: 'trader_sheet_url', kind: 'url', default: '/role-info/spectrum.pdf' },
    // Market parameters (game-creation defaults; read by groupParticipants / startMarket).
    { key: 'market_duration_minutes',  kind: 'positiveInt', default: 90 },
    { key: 'auction_duration_minutes', kind: 'positiveInt', default: 4 },
    { key: 'starting_cash',            kind: 'positiveInt', default: 1000 },
  ],

  // Info page links — keys must appear in configFields above.
  roleInfoLinks: [
    { roleKey: 'trader', links: [{ key: 'trader_sheet_url', label: 'Role sheet' }] },
  ],

  // ── prepDefaults: single-option KC gate + STUB graded questions + reflection ──
  // PHASE A STUB. The gate (Q0) is a single-option role question — Spectrum has ONE
  // role, so "Trader" is always the true answer and it passes on the first click; it is
  // graded 'assigned_role' (server-side, against the student's real role) and is NOT
  // part of the KC score. Q1–Q2 are PLACEHOLDER graded MC purely to exercise the KC UI
  // and grader end-to-end — they are NOT Gary's content. The FINAL KC content
  // (Spectrum_KC_Questions_v2.md, 4 questions) lands in Slice 6, replacing Q1–Q2. One
  // ungraded reflection keeps the prep phase + Reports text tile populated.
  // Stored as DATA OBJECTS here (admin-defaults constraint) — never inline-hardcoded.
  prepDefaults: [
    // ── Q0: role gate (system, ungraded — single option; always passes) ──────────
    {
      field: 'kc_gate_trader', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'trader',
      prompt: 'What is your role in this market?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'trader', label: 'Trader' },
      ],
      explanation: 'You are a Trader in the spectrum-license market.',
    },

    // ── Q1: PLACEHOLDER graded stub (replaced by Slice 6 KC content) ──────────────
    {
      field: 'kc_stub_one', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'stub_correct', role_target: 'trader',
      prompt: '[PLACEHOLDER — Phase A stub] This is a placeholder knowledge-check question. Which option is marked correct?',
      placeholder: '', order: 1, hidden: false, deletable: false,
      options: [
        { value: 'stub_correct', label: 'This one (the correct placeholder answer).' },
        { value: 'stub_wrong_a', label: 'A wrong placeholder answer.' },
        { value: 'stub_wrong_b', label: 'Another wrong placeholder answer.' },
      ],
      explanation: 'Placeholder explanation. Real KC content lands in Slice 6 (Spectrum_KC_Questions_v2.md).',
    },

    // ── Q2: PLACEHOLDER graded stub (replaced by Slice 6 KC content) ──────────────
    {
      field: 'kc_stub_two', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'stub_true', role_target: 'trader',
      prompt: '[PLACEHOLDER — Phase A stub] A second placeholder knowledge-check question. Which option is true?',
      placeholder: '', order: 2, hidden: false, deletable: false,
      options: [
        { value: 'stub_false', label: 'A false placeholder statement.' },
        { value: 'stub_true',  label: 'The true placeholder statement.' },
      ],
      explanation: 'Placeholder explanation. Real KC content lands in Slice 6.',
    },

    // ── Ungraded reflection (participation only) ──────────────────────────────────
    {
      field: 'prep_trader_reflection', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'trader',
      prompt: '[PLACEHOLDER — Phase A] Before the market opens: what is your going-in strategy?',
      placeholder: '', order: 20, hidden: false, deletable: true,
    },
  ],

  // Legacy stub fields — must be present but content served via prepDefaults above.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
