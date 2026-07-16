import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken, signOut, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { auth } from '../firebase'
import { getInstructorSession } from '../api'

// ── Instructor session bootstrap for the live market dashboard (Slice 4). ─────────────
// The shared <InstructorDashboard> owns this bootstrap for /dashboard; the live market
// surface (/market) is a SEPARATE route, so it re-runs the SAME handshake against the SAME
// callable: a classroom JWT (?token=&game_instance_id=) — or, in DEV only, the emulator
// bypass (?_dev_game_instance_id=) — is exchanged via getInstructorSession for a Firebase
// custom token, and signInWithCustomToken establishes the session the read callables ride.
//
// ⚠️ JWT-EXPIRED FIX (dry-run item 1): the classroom launch JWT is a ONE-TIME token (~15 min).
// A 90-minute market outlives it, so this hook must NOT re-exchange the URL token on every mount
// — once a Firebase instructor session exists it AUTO-REFRESHES its ID token and lasts the whole
// market. So we mirror the shared dashboard: wait for authStateReady, REUSE auth.currentUser when
// its uid is instructor_<gid>, and fall back to the token exchange ONLY when there is no session.
// Before the fix, opening /market (or refreshing it) after 15 min hit getInstructorSession with an
// expired token → the red "jwt expired" page. This is the SAME root cause as the transaction-report
// failure; Reports.tsx already reuses currentUser this way.

export type InstructorSession = {
  status: 'loading' | 'ready' | 'error'
  gameInstanceId: string | null
  error?: string
}

export function useInstructorSession(): InstructorSession {
  const [searchParams] = useSearchParams()
  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true
    const args = devGameInstanceId
      ? ({ _dev: { game_instance_id: devGameInstanceId } } as const)
      : tokenParam ? ({ token: tokenParam } as const) : null
    if (!args) { setStatus('error'); setError('No launch token found.'); return }

    ;(async () => {
      try {
        // Reuse an already-established instructor session before touching the (expiring) URL token.
        await auth.authStateReady()
        if (!alive) return
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (auth.currentUser) {
          if (expectedUid && auth.currentUser.uid === expectedUid) { setStatus('ready'); return }
          await signOut(auth)               // stale/foreign session — clear before re-exchanging
          if (!alive) return
        }
        // First load only: exchange the one-time classroom JWT for a Firebase session.
        if (searchParams.get('_session') === 'tab') await setPersistence(auth, browserSessionPersistence)
        const res = await getInstructorSession(args)
        await signInWithCustomToken(auth, res.customToken)
        if (alive) setStatus('ready')
      } catch (e: unknown) {
        if (alive) { setStatus('error'); setError(e instanceof Error ? e.message : 'Session failed.') }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devGameInstanceId, tokenParam])

  const gameInstanceId = devGameInstanceId ?? gameInstanceIdParam ?? null
  return { status, gameInstanceId, error }
}
