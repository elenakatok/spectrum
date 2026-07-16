import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import InstructorMarket from './pages/InstructorMarket'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

const spectrumRoleLabels: Record<string, string> = {
  trader: 'Trader',
}

const spectrumInfoLinks = [
  { roleKey: 'trader', links: [
    { key: 'trader_sheet_url', label: 'Role sheet' },
  ]},
]

// Instructor-editable market knobs on the game-creation/settings screen — same SettingsPage
// mechanism eBay uses for its auction duration. Keys must match configFields in
// functions/src/gameDefinition.ts; market_duration_minutes is read by startMarket at open time
// (falls back to the compiled default of 90). N (numTeams) is NOT here — it is chosen on the
// dashboard at grouping time.
const spectrumConfigSections = [
  {
    id: 'market',
    title: 'Market',
    fields: [
      { key: 'market_duration_minutes',  label: 'Market duration (minutes)',  kind: 'positiveInt' as const, placeholder: '90' },
      { key: 'auction_duration_minutes', label: 'Auction duration (minutes)', kind: 'positiveInt' as const, placeholder: '4' },
      { key: 'starting_cash',            label: 'Starting cash per team',      kind: 'positiveInt' as const, placeholder: '1000' },
    ],
  },
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/market"    element={<InstructorMarket />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — Spectrum"
            functions={functions}
            auth={auth}
            roleLabels={spectrumRoleLabels}
            roleInfoLinks={spectrumInfoLinks}
            configSections={spectrumConfigSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
