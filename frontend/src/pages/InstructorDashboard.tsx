import { InstructorDashboard as SharedDashboard } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { spectrumConfig } from '../gameConfig'

const roleLabels = Object.fromEntries(
  spectrumConfig.roles.map(r => [r.key, r.label])
)

// PHASE A SKELETON: just the shared instructor dashboard (attendance → match →
// finalize → push). The live-market controls (start market, open auctions, activity
// feed, projectable ownership board) arrive in Slice 4.
//
// composition {trader:4} is PLACEHOLDER scaffolding so the shared canMatch gates on
// ≥4 traders (single role) — Slice 0 replaces it with the real team model.

export default function InstructorDashboard() {
  return (
    <SharedDashboard
      title="Instructor Dashboard — Spectrum"
      roleLabels={roleLabels}
      composition={{ trader: 4 }}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
      reportsRoute="/reports"
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Score & Record' }}
    />
  )
}
