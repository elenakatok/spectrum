import { useEffect, useState } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { getTeamsDirectory, type TeamDirectoryEntry } from '../api'

// ── Teams tab (v3 §11.3) — the public directory: team number → student NAMES. ──
// Served through getTeamsDirectory (student-authed) — never a world-readable feed
// (privacy-walk leg 5). Names only; never a portfolio, cash, password, or synergy.

export default function TeamsTab({ myTeam }: { myTeam: number | null }) {
  const [teams, setTeams] = useState<TeamDirectoryEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      getTeamsDirectory()
        .then((r) => { if (alive) { setTeams(r.teams); setErr(null) } })
        .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : 'Could not load teams.') })
    load()
    const id = setInterval(load, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (err) return <p style={{ color: '#c00' }}>{err}</p>
  if (!teams) return <p style={{ color: colors.textSecondary }}>Loading teams…</p>

  return (
    <div data-testid="teams-tab">
      <h2 style={{ fontSize: '1.1rem', marginTop: 0, marginBottom: spacing.gapSm }}>Teams</h2>
      <p style={{ color: colors.textSecondary, marginTop: 0, marginBottom: spacing.gapMd, fontSize: '0.85rem' }}>
        Who is on each team. Use this to find a counterparty — then walk over and trade.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: spacing.gapSm }}>
        {teams.map((t) => (
          <div
            key={t.team_number}
            data-testid={`team-card-${t.team_number}`}
            style={{
              border: '1px solid #d0d7de', borderRadius: 8, padding: '0.6rem 0.8rem',
              background: t.team_number === myTeam ? '#fff2dd' : '#fff',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
              Team {t.team_number}{t.team_number === myTeam ? ' (you)' : ''}
            </div>
            {t.team_number === myTeam ? (
              // Own team: one member per line so an email can sit under each name.
              // Emails only ever arrive for this team — see getTeamsDirectory.
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(t.members ?? t.member_names.map((n) => ({ name: n, email: null }))).map((m, i) => (
                  <li key={`${m.name}-${i}`} style={{ marginBottom: '0.3rem' }}>
                    <div style={{ fontSize: '0.9rem', color: colors.textSecondary, lineHeight: 1.35 }}>
                      {m.name}
                    </div>
                    {m.email && (
                      // Nothing renders when a member has no email — no blank line.
                      <div style={{
                        fontSize: '0.75rem',
                        color: colors.textSecondary,
                        opacity: 0.7,
                        lineHeight: 1.3,
                        overflowWrap: 'anywhere',
                      }}>
                        {m.email}
                      </div>
                    )}
                  </li>
                ))}
                {t.member_names.length === 0 && (
                  <li style={{ fontSize: '0.9rem', color: colors.textSecondary }}>—</li>
                )}
              </ul>
            ) : (
              // Every other team is unchanged: names only, comma-joined.
              <div style={{ fontSize: '0.9rem', color: colors.textSecondary, lineHeight: 1.5 }}>
                {t.member_names.length ? t.member_names.join(', ') : '—'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
