import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'

// Emulator-only: seed participants and RTDB presence for triggerMatching tests.
export const seedMatchTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown; participants?: unknown; clear?: unknown
  }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' })
    return
  }
  if (!Array.isArray(body.participants)) {
    res.status(400).json({ error: 'participants array required' })
    return
  }

  // Spectrum: single role `trader`. `present` (default true) controls RTDB presence, so a
  // seeded no-show (present:false) is attendance-set but held out of grouping. `clear`
  // (default true) wipes existing state; pass clear:false to APPEND fillers to a live run
  // (used by the Slice 0 grouping test — 14 present needed, but the UI drove only a few).
  type SeedP = { id: string; role: 'trader'; present?: boolean }
  const gameInstanceId = body.game_instance_id
  const participants = body.participants as SeedP[]
  const clear = body.clear !== false // default true

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  if (clear) {
    // Clear existing participants and groups for a clean test run.
    const [existingPs, existingGs] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
    ])
    if (existingPs.size > 0 || existingGs.size > 0) {
      const clearBatch = db.batch()
      for (const d of existingPs.docs) clearBatch.delete(d.ref)
      for (const d of existingGs.docs) clearBatch.delete(d.ref)
      await clearBatch.commit()
    }
    await rtdb.ref(`presence/${gameInstanceId}`).remove()
  }

  // Seed participant docs and RTDB presence.
  const seedBatch = db.batch()
  const presenceData: Record<string, unknown> = {}
  for (const p of participants) {
    seedBatch.set(instanceRef.collection('participants').doc(p.id), {
      participant_id: p.id,
      game_instance_id: gameInstanceId,
      role: p.role,
      prep_status: 'complete',
      attendance_confirmed_at: now,
      confirmed_ready_at: now,
    })
    if (p.present !== false) presenceData[p.id] = { online: true, last_seen: now.toMillis() }
  }
  await seedBatch.commit()
  // MERGE presence (update, not set) so appending fillers never wipes UI students' presence.
  if (Object.keys(presenceData).length > 0) {
    await rtdb.ref(`presence/${gameInstanceId}`).update(presenceData)
  }

  res.json({ ok: true, seeded: participants.length })
})

// Emulator-only: seed a matched group directly (bypass triggerMatching) for outcome tests.
// Spectrum group composition: single role `trader`, 4–7 participants per group.
export const seedGroupForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown
    group_id?: unknown
    lead_id?: unknown
    trader_participants?: unknown
  }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  if (typeof body.group_id !== 'string' || !body.group_id) {
    res.status(400).json({ error: 'group_id required' }); return
  }
  if (typeof body.lead_id !== 'string' || !body.lead_id) {
    res.status(400).json({ error: 'lead_id required' }); return
  }
  if (!Array.isArray(body.trader_participants)) {
    res.status(400).json({ error: 'trader_participants array required' }); return
  }

  const gameInstanceId = body.game_instance_id
  const groupId = body.group_id
  const leadId = body.lead_id
  const traderPids = body.trader_participants as string[]

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // Clear any existing state.
  const [existingPs, existingGs] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingPs.size > 0 || existingGs.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingPs.docs) clearBatch.delete(d.ref)
    for (const d of existingGs.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }

  // Write group doc with the single-role participant array.
  const groupRef = instanceRef.collection('groups').doc(groupId)
  await groupRef.set({
    group_id: groupId,
    game_instance_id: gameInstanceId,
    trader_participants: traderPids,
    lead_participant_id: leadId,
    outcome: null,
    status: 'matched',
    matched_at: now,
  })

  // Write participant docs.
  const batch = db.batch()
  for (const pid of traderPids) {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'trader',
      group_id: groupId,
      is_lead: pid === leadId,
      attendance_confirmed_at: now,
    })
  }
  await batch.commit()

  res.json({ ok: true, group_id: groupId, lead_id: leadId })
})
