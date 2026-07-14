import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { spectrumGameDef } from './gameDefinition'

// PHASE A SKELETON. Per-student participation + KC + free-text only. The full market
// reports (leaderboard cash+licenses, transaction history with prices, price-over-time)
// land in Slice 7 (Spectrum_Build_Plan_v1.md) — portfolio value NEVER enters the grade.

// Derived from the role config (single role `trader`).
export const VALID_ROLES = new Set(spectrumGameDef.roles.roles.map(r => r.key))

// Text questions from prepDefaults — read once at module load (for the free-text tiles).
export const TEXT_QUESTIONS = (spectrumGameDef.prepDefaults ?? [])
  .filter(q => q.format === 'text' && !q.hidden)
  .map(q => ({ field: q.field, prompt: q.prompt, role_target: q.role_target }))

export const TEXT_FIELDS = TEXT_QUESTIONS.map(q => q.field)

// ── Report row shape ──────────────────────────────────────────────────────────

/** One row per finalized student. Participation + KC are the grade; nothing else. */
export type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  group_id: string | null
  role: string
  /** Flat participation point (1 = present) — the grade component. null = no-show. */
  participation: number | null
  knowledge_check_score: number | null
  text_answers: Record<string, string>
}

// ── The callable ────────────────────────────────────────────────────────────────

export const getReportData = onCall({ cors: spectrumGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const rtdb = admin.database()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [participantsSnap, groupsSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])

    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    const groupNumberMap = new Map<string, number>(sortedGroups.map((g, i) => [g.id, i + 1]))

    type PData = Record<string, unknown>
    const pById = new Map<string, PData>()
    for (const p of participantsSnap.docs) pById.set(p.id, p.data() as PData)

    const nameOf = (pid: string): string => {
      const d = pById.get(pid) ?? {}
      const rtdbName = attending[pid]?.display_name?.trim()
      const fsName = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      return rtdbName || fsName || `${pid.slice(0, 8)}…`
    }

    // ── Per-student rows ─────────────────────────────────────────────────────────
    const rows: ReportRow[] = []
    for (const pdoc of participantsSnap.docs) {
      const d = pdoc.data() as PData
      if (d['finalized_at'] == null) continue
      const role = d['role'] as string | undefined
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['raw_score'] === null || d['raw_score'] === undefined) continue   // no-shows excluded

      const groupId = (d['group_id'] as string | undefined) ?? null

      const text_answers: Record<string, string> = {}
      for (const field of TEXT_FIELDS) {
        const val = d[field]
        if (typeof val === 'string' && val.trim()) text_answers[field] = val.trim()
      }

      rows.push({
        participant_id: pdoc.id,
        display_name: nameOf(pdoc.id),
        group_number: groupId ? (groupNumberMap.get(groupId) ?? null) : null,
        group_id: groupId,
        role,
        participation: d['raw_score'] as number,
        knowledge_check_score: (d['knowledge_check_score'] as number | null) ?? null,
        text_answers,
      })
    }

    rows.sort((x, y) => {
      const gn = (x.group_number ?? Infinity) - (y.group_number ?? Infinity)
      if (gn !== 0) return gn
      return x.display_name.localeCompare(y.display_name)
    })

    return { ok: true as const, rows, questions: TEXT_QUESTIONS }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getReportData] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
