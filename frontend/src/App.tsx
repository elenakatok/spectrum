import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
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

// PHASE A SKELETON: no custom Settings sections. The trading-market knobs (market
// duration, N teams, etc.) arrive with the market in Slices 0–5.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — Spectrum"
            functions={functions}
            auth={auth}
            roleLabels={spectrumRoleLabels}
            roleInfoLinks={spectrumInfoLinks}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
