import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { auth } from '../firebase'
import { getInstructorSession } from '../api'

// ── Instructor session bootstrap for the live market dashboard (Slice 4). ─────────────
// The shared <InstructorDashboard> owns this bootstrap for /dashboard; the live market
// surface (/market) is a SEPARATE route, so it re-runs the SAME handshake against the SAME
// callable: a classroom JWT (?token=&game_instance_id=) — or, in DEV only, the emulator
// bypass (?_dev_game_instance_id=) — is exchanged via getInstructorSession for a Firebase
// custom token, and signInWithCustomToken establishes the session the read callables ride.

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
