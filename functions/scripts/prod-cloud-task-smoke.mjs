// Spectrum PRODUCTION Cloud-Task smoke — proves the ONE thing the emulator could not:
// a REAL Cloud Task, scheduled by createAuction's own enqueue at the auction's ends_at,
// fires on schedule in real GCP and settles the auction — with NO resolve-on-read touch.
//
// WHY the emulator can't prove this: its harness POSTs directly to the settleAuctionTask
// HTTP endpoint (no Cloud Tasks queue, no scheduled dispatch, no OIDC). This exercises the
// real queue: enqueue -> scheduled dispatch at ends_at -> deployed settleAuctionTask ->
// runSettlement, all against spectrum-mygames-live.
//
// FIDELITY / attribution: after createAuction + placeBid (both BEFORE ends_at), this script
// touches the auction ONLY via passive admin .get() — it NEVER calls getAuctionState/placeBid
// after ends_at, so the resolve-on-read backstop cannot be the settler. If the doc becomes
// 'settled', the Cloud Task did it. That is the proof.
//
// MODE 1 (high fidelity, default): mint real student ID tokens -> call the DEPLOYED
//         createAuction (createAuction's SA does the real enqueue) -> placeBid.
// MODE 2 (fallback, if token/callable path fails at setup): admin-seed an open auction+bid
//         and enqueue the settle task with the SAME getFunctions().taskQueue().enqueue call
//         createAuction uses. Still a real Cloud Task; only createAuction's own onCall is skipped.
//
// Requires Application Default Credentials with Owner/Editor on spectrum-mygames-live
// (Elena's gcloud user ADC works). Reads the web API key from ../../frontend/.env.local.
// Seeds a throwaway game_instance and recursively deletes it at the end (SMOKE_KEEP=1 keeps it).
//
//   node functions/scripts/prod-cloud-task-smoke.mjs
//
// Env knobs: SMOKE_DURATION_S (auction lifetime, default 90), SMOKE_WAIT_MARGIN_S (extra wait
// past ends_at, default 150), SMOKE_KEEP=1 (skip cleanup), SMOKE_FORCE_MODE2=1 (skip the callable path).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import admin from 'firebase-admin'
import { getFunctions } from 'firebase-admin/functions'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT = 'spectrum-mygames-live'
const REGION = 'us-central1'
const APPSPOT_SA = `${PROJECT}@appspot.gserviceaccount.com`
const DURATION_S = Number(process.env.SMOKE_DURATION_S || 90)
const WAIT_MARGIN_S = Number(process.env.SMOKE_WAIT_MARGIN_S || 150)
const KEEP = process.env.SMOKE_KEEP === '1'
const FORCE_MODE2 = process.env.SMOKE_FORCE_MODE2 === '1'

// ── identifiers (unique per run) ──
const stamp = Date.now()
const GID = `smoke-cloudtask-${stamp}`
const SELLER = 1, BIDDER = 2
const GSELL = `grp-seller-${stamp}`, GBID = `grp-bidder-${stamp}`
const SELLER_PID = `smoke-seller-${stamp}`, BIDDER_PID = `smoke-bidder-${stamp}`
const REGION_CODE = 'A'
const BID_AMOUNT = 100
const SELLER_CASH0 = 1000, BIDDER_CASH0 = 1000
const LIC = [`lic-${stamp}-A1`, `lic-${stamp}-A2`]  // seller owns 2 in region A; auction 1 -> lot = [LIC[0]] (sorted)

const log = (...a) => console.log(...a)
const ok = (c, m) => log(`${c ? '  ✅' : '  ❌'} ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── init admin with ADC (reads ~/.config/gcloud/application_default_credentials.json; no gcloud binary) ──
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: PROJECT,
  serviceAccountId: APPSPOT_SA, // lets createCustomToken sign via IAM signBlob under user ADC
})
const db = admin.firestore()
const instanceRef = db.collection('game_instances').doc(GID)

function webApiKey() {
  const env = readFileSync(resolve(__dirname, '../../frontend/.env.local'), 'utf8')
  const m = env.match(/^VITE_FIREBASE_API_KEY=(.+)$/m)
  if (!m) throw new Error('VITE_FIREBASE_API_KEY not found in frontend/.env.local')
  return m[1].trim()
}

// ── seed the minimal state createAuction + runSettlement require ──
async function seedBaseState(closesAtMs, durationMin) {
  const truthBase = { escrowed: 0, synergy: [], password: 'smoke', portfolio_value: 0 }
  await Promise.all([
    instanceRef.set({ smoke: true, created_by: 'prod-cloud-task-smoke', created_ms: stamp }),
    instanceRef.collection('market').doc('state').set({
      status: 'open',
      closes_at: Timestamp.fromMillis(closesAtMs),
      auction_duration_minutes: durationMin,
    }),
    instanceRef.collection('groups').doc(GSELL).set({ team_number: SELLER, license_ids: LIC.slice().sort() }),
    instanceRef.collection('groups').doc(GBID).set({ team_number: BIDDER, license_ids: [] }),
    instanceRef.collection('groups').doc(GSELL).collection('truth').doc('team')
      .set({ ...truthBase, cash: SELLER_CASH0, license_ids: LIC.slice().sort() }),
    instanceRef.collection('groups').doc(GBID).collection('truth').doc('team')
      .set({ ...truthBase, cash: BIDDER_CASH0, license_ids: [] }),
    instanceRef.collection('participants').doc(SELLER_PID).set({ team_number: SELLER, group_id: GSELL }),
    instanceRef.collection('participants').doc(BIDDER_PID).set({ team_number: BIDDER, group_id: GBID }),
    ...LIC.map((id) => instanceRef.collection('licenses').doc(id)
      .set({ owner_team: SELLER, region: REGION_CODE, under_auction: null })),
  ])
}

// ── mint a real student ID token: custom token (dev claims) -> Identity Toolkit exchange ──
async function mintStudentIdToken(uid) {
  const customToken = await admin.auth().createCustomToken(uid, { game_instance_id: GID, role: 'student' })
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey()}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
  )
  const j = await res.json()
  if (!res.ok || !j.idToken) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(j)}`)
  return j.idToken
}

// ── call a deployed v2 onCall, resolving the gen2 302 -> run.app WITHOUT dropping the auth header ──
async function callCallable(name, data, idToken) {
  const cfUrl = `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }
  const body = JSON.stringify({ data })
  let res = await fetch(cfUrl, { method: 'POST', headers, body, redirect: 'manual' })
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location')
    if (!loc) throw new Error(`${name}: redirect with no Location`)
    res = await fetch(loc, { method: 'POST', headers, body }) // re-POST to run.app, header preserved
  }
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.error) throw new Error(`${name} -> ${res.status} ${JSON.stringify(j.error ?? j)}`)
  return j.result
}

// ── MODE 2 fallback: seed an open auction + bid, then enqueue the settle task ourselves ──
async function seedAuctionAndEnqueue(endsAtMs) {
  const auctionId = `smoke-auc-${stamp}`
  await instanceRef.collection('auctions').doc(auctionId).set({
    auction_id: auctionId, region: REGION_CODE, quantity: 1, seller_team: SELLER,
    reserve: 0, license_ids: [LIC.slice().sort()[0]], status: 'open',
    ends_at: Timestamp.fromMillis(endsAtMs), created_at: FieldValue.serverTimestamp(),
    winner_team: null, clearing_price: null,
  })
  await instanceRef.collection('licenses').doc(LIC.slice().sort()[0]).update({ under_auction: auctionId })
  await instanceRef.collection('auctions').doc(auctionId).collection('bids').doc(`team-${BIDDER}`)
    .set({ team_number: BIDDER, amount: BID_AMOUNT, at: stamp, acted_by: 'seed' })
  await instanceRef.collection('groups').doc(GBID).collection('truth').doc('team')
    .update({ escrowed: BID_AMOUNT })
  await getFunctions().taskQueue('settleAuctionTask').enqueue( // 2nd arg is extensionId, NOT region; location defaults to us-central1
    { game_instance_id: GID, auction_id: auctionId },
    { scheduleTime: new Date(endsAtMs) },
  )
  return auctionId
}

async function main() {
  log(`\n=== Spectrum PROD Cloud-Task smoke → ${PROJECT} ===`)
  log(`instance=${GID}  duration=${DURATION_S}s  wait-margin=${WAIT_MARGIN_S}s  keep=${KEEP}\n`)

  const nowMs = Date.now()
  const durationMin = DURATION_S / 60
  const closesAtMs = nowMs + 60 * 60_000 // market closes in 1h — well past the auction + 5-min cutoff
  await seedBaseState(closesAtMs, durationMin)
  log('· seeded base state (market open, 2 teams, seller holds 2 region-A licenses)')

  let mode, auctionId, endsAtMs
  if (!FORCE_MODE2) {
    try {
      const [sellerTok, bidderTok] = await Promise.all([mintStudentIdToken(SELLER_PID), mintStudentIdToken(BIDDER_PID)])
      const created = await callCallable('createAuction', { region: REGION_CODE, quantity: 1, reserve: 0 }, sellerTok)
      auctionId = created.auction_id
      endsAtMs = created.ends_at
      log(`· MODE 1: createAuction ok → auction=${auctionId} ends_at=+${Math.round((endsAtMs - Date.now()) / 1000)}s (real enqueue by createAuction's SA)`)
      const bid = await callCallable('placeBid', { auction_id: auctionId, amount: BID_AMOUNT }, bidderTok)
      log(`· MODE 1: placeBid ok → team ${BIDDER} bid ${bid.amount}`)
      mode = 1
    } catch (err) {
      log(`· MODE 1 unavailable (${err.message}) → falling back to MODE 2 (admin enqueue)`)
    }
  }
  if (mode !== 1) {
    endsAtMs = Date.now() + DURATION_S * 1000
    auctionId = await seedAuctionAndEnqueue(endsAtMs)
    log(`· MODE 2: seeded auction=${auctionId}, enqueued settle task @ +${DURATION_S}s`)
    mode = 2
  }

  // ── WAIT for the scheduled task, polling the auction with PASSIVE admin reads only ──
  const auctionRef = instanceRef.collection('auctions').doc(auctionId)
  const deadlineMs = endsAtMs + WAIT_MARGIN_S * 1000
  log(`\n· waiting for the Cloud Task (ends_at=${new Date(endsAtMs).toISOString()}, giving up at +${WAIT_MARGIN_S}s past it)…`)
  let settledDoc = null, settledAtWallMs = null
  while (Date.now() < deadlineMs) {
    const d = (await auctionRef.get()).data()
    if (d && d.status !== 'open') { settledDoc = d; settledAtWallMs = Date.now(); break }
    const remaining = Math.round((endsAtMs - Date.now()) / 1000)
    log(`    …status=${d?.status ?? '(gone)'}  (ends_at ${remaining > 0 ? `in ${remaining}s` : `${-remaining}s ago`})`)
    await sleep(10_000)
  }

  // ── VERIFY ──
  log('\n=== RESULTS ===')
  let pass = true
  const chk = (c, m) => { ok(c, m); if (!c) pass = false }

  chk(!!settledDoc, `auction reached a terminal status via the Cloud Task (no getAuctionState call was ever made)`)
  if (settledDoc) {
    const lag = Math.round((settledAtWallMs - endsAtMs) / 1000)
    log(`     → settled ~${lag}s after ends_at (Cloud Tasks dispatch latency); status=${settledDoc.status}`)
    chk(settledDoc.status === 'settled', `status === 'settled' (a sale)`)
    chk(settledDoc.winner_team === BIDDER, `winner_team === ${BIDDER} (the sole bidder)`)
    chk(settledDoc.clearing_price === BID_AMOUNT, `clearing_price === ${BID_AMOUNT} (first-price)`)

    const lot = (settledDoc.license_ids ?? [])[0]
    const licOwner = (await instanceRef.collection('licenses').doc(lot).get()).data()
    chk(licOwner?.owner_team === BIDDER && licOwner?.under_auction == null,
      `license ${lot}: owner_team → ${BIDDER}, under_auction cleared`)

    const st = (await instanceRef.collection('groups').doc(GSELL).collection('truth').doc('team').get()).data()
    const bt = (await instanceRef.collection('groups').doc(GBID).collection('truth').doc('team').get()).data()
    chk(st?.cash === SELLER_CASH0 + BID_AMOUNT, `seller cash ${SELLER_CASH0} → ${st?.cash} (+${BID_AMOUNT})`)
    chk(bt?.cash === BIDDER_CASH0 - BID_AMOUNT, `bidder cash ${BIDDER_CASH0} → ${bt?.cash} (−${BID_AMOUNT})`)
    chk(Number(bt?.escrowed) === 0, `bidder escrow released → 0`)
    const conserved = (Number(st?.cash) + Number(bt?.cash)) === (SELLER_CASH0 + BIDDER_CASH0)
    chk(conserved, `cash conserved across the two teams (${SELLER_CASH0 + BIDDER_CASH0})`)
  }

  log(`\nMode: ${mode === 1 ? '1 (drove deployed createAuction — its SA really enqueued)' : '2 (admin enqueue — createAuction onCall skipped)'}`)
  log(pass && settledDoc
    ? `\n🟢 PASS — a real Cloud Task fired on schedule and settled the auction in production.`
    : `\n🔴 FAIL — see above. (Tip: SMOKE_KEEP=1 to inspect the instance; the resolve-on-read backstop still guarantees settlement on next read, so a timeout here means the TASK was late/absent, not that data is corrupt.)`)

  // ── cleanup ──
  if (KEEP) {
    log(`\n(SMOKE_KEEP=1 — leaving ${GID} in place for inspection)`)
  } else {
    await db.recursiveDelete(instanceRef)
    log(`\n· cleaned up ${GID}`)
  }
  return pass && !!settledDoc
}

main()
  .then((good) => process.exit(good ? 0 : 1))
  .catch(async (err) => {
    console.error('\n💥 smoke crashed:', err)
    try { if (!KEEP) await db.recursiveDelete(instanceRef) } catch {}
    process.exit(2)
  })
