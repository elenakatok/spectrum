import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition, PrepTextQuestion } from '@mygames/game-server'

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

// ── Knowledge Check content (Spectrum_KC_Questions_v3.md — FINAL) ──────────────
// 13 graded questions + the single-option role gate. Answer key: gate A · then
// C·A·B·B·B·B·B·B·B·B·B·B·C. Grading + the per-student option shuffle are handled by
// the shared factory (getStudentPrepQuestions seededShuffle by djb2(pid+':'+field);
// submitStaticKnowledgeCheckQuestion grades by option VALUE = content, not letter —
// so the answer key survives the shuffle. Q5–Q12 are all B and Q13 is C in the source;
// the shuffle is what stops a pattern-answerer scoring on position alone).

// Q2, Q3, Q4 all reference this ONE region-Y value schedule — stored once, not triplicated.
// (The KC prompt renders as plain text, so the schedule is an inline one-line string rather
// than a table; a rendered table would need a game-ui change. Values are Gary's exactly.)
const REGION_Y_SCHEDULE =
  'The value schedule for region Y (total value for each quantity of licenses held) is — ' +
  '1: 100, 2: 250, 3: 380, 4: 500, 5: 610, 6: 690, 7: 775, 8: 900.'

// A graded static MC question — the shared shape for all 13. `correct_value` names the option
// VALUE (content id), so grading is position-independent under the per-student shuffle.
const gq = (
  field: string, order: number, correct_value: string,
  prompt: string, options: { value: string; label: string }[], explanation: string,
): PrepTextQuestion => ({
  field, type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
  grading: 'static', correct_value, role_target: 'trader', prompt,
  placeholder: '', order, hidden: false, deletable: false, options, explanation,
})

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

  // ── prepDefaults: single-option KC gate + 13 graded questions + reflection ────
  // The gate (Q0) is a single-option role question — Spectrum has ONE role, so "Trader" is
  // always the true answer and it passes on the first click; it is graded 'assigned_role'
  // (server-side, against the student's real role), writes knowledge_check_completed_at, and
  // is NOT part of the KC score. Q1–Q13 are Gary's FINAL content (Spectrum_KC_Questions_v3.md),
  // built via gq() as DATA OBJECTS (admin-defaults constraint) — never inline-hardcoded.
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

    // ── Part I — Case and synergy chart (Q1–Q4) ───────────────────────────────────
    gq('kc_q1', 1, 'q1_sum',
      "Your group's objective in the Spectrum game is to maximize:",
      [
        { value: 'q1_licenses', label: 'the value of your license holdings.' },
        { value: 'q1_cash', label: 'your cash holdings.' },
        { value: 'q1_sum', label: 'the sum value of your license and cash holdings.' },
        { value: 'q1_count', label: 'the number of licenses you hold.' },
      ],
      'Portfolio value = license value + cash. You maximize the sum, not either part alone.'),
    gq('kc_q2', 2, 'q2_100',
      `${REGION_Y_SCHEDULE} If your group owns one license in region Y, the value of that license to you is:`,
      [
        { value: 'q2_100', label: '100' },
        { value: 'q2_250', label: '250' },
        { value: 'q2_610', label: '610' },
        { value: 'q2_690', label: '690' },
      ],
      'One license in Y is worth 100 (the first column of the schedule).'),
    gq('kc_q3', 3, 'q3_250',
      `${REGION_Y_SCHEDULE} If your group owns two licenses in region Y, the value of those holdings to you is:`,
      [
        { value: 'q3_100', label: '100' },
        { value: 'q3_250', label: '250' },
        { value: 'q3_610', label: '610' },
        { value: 'q3_690', label: '690' },
      ],
      'Two licenses in Y are worth 250 in total (the second column).'),
    gq('kc_q4', 4, 'q4_90',
      `${REGION_Y_SCHEDULE} Suppose your group holds six Y licenses. The total synergy you receive is:`,
      [
        { value: 'q4_510', label: '$510' },
        { value: 'q4_90', label: '$90' },
        { value: 'q4_690', label: '$690' },
        { value: 'q4_290', label: '$290' },
      ],
      'Six licenses total 690. Base = 6 × 100 = 600. Synergy = 690 − 600 = $90. ($290 = 690 − 400 is the miscalculation that subtracts the 4-license base.)'),

    // ── Part II — Prebrief: market rules and platform (Q5–Q9) ──────────────────────
    // These five are a correctness spec for the build — each asserts a rule the code enforces.
    gq('kc_q5', 5, 'q5_diff',
      'Which of the following is true about the synergy chart your team receives?',
      [
        { value: 'q5_same', label: 'All teams receive the same chart, so a license worth $100 to you is worth $100 to everyone.' },
        { value: 'q5_diff', label: 'Every team has a different chart, and your chart is private information.' },
        { value: 'q5_identical_regions', label: "Your chart is private, but all teams' charts are identical across regions." },
        { value: 'q5_posted', label: 'Your chart is posted on the market platform for all teams to see.' },
      ],
      "Every team's synergy chart differs and is private — a license's value to a counterparty is unknown to you and must be inferred through bargaining."),
    gq('kc_q6', 6, 'q6_reported',
      'Which statement about recording transactions is correct?',
      [
        { value: 'q6_handshake', label: 'A handshake agreement counts once both parties agree on price.' },
        { value: 'q6_reported', label: 'A trade is not official until it is reported; cash-for-license trades are recorded by the seller, swaps by either party, and auction trades are executed and reported automatically by the platform.' },
        { value: 'q6_buyer_manual', label: 'All trades, including auctions, must be typed in manually by the buyer.' },
        { value: 'q6_instructor', label: 'The instructor records all trades at the end of the market.' },
      ],
      'A trade is official only once reported: the seller records a cash-for-license deal, either party records a swap, and auctions settle server-side.'),
    gq('kc_q7', 7, 'q7_private',
      'To complete a negotiated transaction (cash-for-license or swap):',
      [
        { value: 'q7_shared', label: 'The buyer gives their trading password to the seller, who enters the trade — this is on the honor code, and passwords are never to be shared for any other purpose.' },
        { value: 'q7_private', label: 'One party (the seller if it is a cash-for-license trade) enters the trade and the other party privately enters their password to confirm the trade. Passwords are never shared.' },
        { value: 'q7_email', label: 'Passwords are never used; the platform confirms trades by email.' },
        { value: 'q7_freely', label: 'Teams should freely share passwords to speed up trading.' },
      ],
      'The counterparty types their OWN password privately as a confirmation step. It is never handed over — "password needed" does not mean "password shared."'),
    gq('kc_q8', 8, 'q8_first_price',
      'The auction mechanism built into the Spectrum market platform is:',
      [
        { value: 'q8_english', label: 'An English (ascending, open-bid) auction with a soft close.' },
        { value: 'q8_first_price', label: 'A first-price sealed-bid auction with a hard close, lasting 4 minutes.' },
        { value: 'q8_vickrey', label: 'A second-price (Vickrey) sealed-bid auction.' },
        { value: 'q8_dutch', label: 'A Dutch (descending-price) auction.' },
      ],
      'First-price sealed-bid, hard close, 4 minutes. A hard close makes late bids decisive and early bids nearly irrelevant.'),
    gq('kc_q9', 9, 'q9_hard',
      'Which is true about the end of the market?',
      [
        { value: 'q9_honored', label: 'Time remaining is displayed publicly to all teams; trades in progress at the bell are honored.' },
        { value: 'q9_hard', label: 'Time remaining is public to all teams, and there is a HARD CLOSE — no trade is recorded after the clock expires.' },
        { value: 'q9_no_team', label: 'The market ends only when no team wishes to trade further.' },
        { value: 'q9_extends', label: 'The instructor extends the market if teams are mid-negotiation.' },
      ],
      'The clock is public, and the close is HARD and server-authoritative: a deal submitted after the clock expires is rejected, not honored.'),

    // ── Part III — Auctions versus negotiations, from the primer (Q10–Q13) ─────────
    gq('kc_q10', 10, 'q10_five_eight',
      'According to the primer, auctions tend to work best when:',
      [
        { value: 'q10_one', label: 'There is exactly one qualified counterparty.' },
        { value: 'q10_five_eight', label: 'There are multiple qualified bidders, roughly five to eight; beyond about 15 the value of each additional bidder is negligible while administrative complexity rises.' },
        { value: 'q10_no_limit', label: 'The more bidders the better, with no upper limit on useful competition.' },
        { value: 'q10_dispersed', label: "The bidders' valuations are widely dispersed." },
      ],
      'Auctions work best with several qualified bidders (~5–8); past ~15 the marginal bidder adds little while complexity rises.'),
    gq('kc_q11', 11, 'q11_gap',
      'Auction theory predicts the final price will land slightly above the second-highest valuation. This implies that a seller should be most wary of running an auction when:',
      [
        { value: 'q11_close', label: 'The top two valuations are very close together.' },
        { value: 'q11_gap', label: 'One bidder has unique synergies with the asset, so there is a wide gap between the highest and second-highest valuation.' },
        { value: 'q11_identical', label: 'All bidders value the asset identically.' },
        { value: 'q11_many_similar', label: 'There are many bidders with similar valuations.' },
      ],
      'With a wide gap the auction price is set by the weak second bidder and the seller leaves money on the table — negotiating with the high-synergy bidder captures more. This is the game: two teams want each block, only one is right.'),
    gq('kc_q12', 12, 'q12_joint',
      'Which asset attribute favors negotiation over auction?',
      [
        { value: 'q12_specifiable', label: 'High specifiability — the item is a standardized commodity with clear specifications.' },
        { value: 'q12_joint', label: 'Significant potential for joint value creation through collaboration, alternative configurations, or an ongoing service relationship.' },
        { value: 'q12_transparent', label: 'A need for a transparent, auditable process that treats all bidders equally.' },
        { value: 'q12_deteriorate', label: "Rapid deterioration of the asset's value over time." },
      ],
      'Potential for joint value creation favors negotiation. Specifiability, transparency/fairness, and speed all favor auctions.'),
    gq('kc_q13', 13, 'q13_hybrid',
      "Which statement best reflects the primer's treatment of auctions and negotiations?",
      [
        { value: 'q13_exclusive', label: 'They are mutually exclusive; a process is one or the other.' },
        { value: 'q13_confidential', label: 'Confidentiality favors auctions, because fewer parties see the information.' },
        { value: 'q13_hybrid', label: 'They are not mutually exclusive — a common hybrid runs an auction to identify finalists, then negotiates with those finalists to refine terms beyond price.' },
        { value: 'q13_slower', label: 'Negotiations are always slower and riskier than auctions.' },
      ],
      'A common hybrid auctions to identify finalists, then negotiates with them. (Confidentiality favors negotiation, not auctions; negotiation can reduce certain risks even though it is slower.)'),

    // Spectrum has NO free-text prep question — the debrief lives entirely in the five market
    // reports (v3 §13). The former `prep_trader_reflection` reflection was removed in Slice 7:
    // it surfaced as an empty "No responses yet" card on the Reports overview (Slice-6 review).
  ],

  // Legacy stub fields — must be present but content served via prepDefaults above.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
