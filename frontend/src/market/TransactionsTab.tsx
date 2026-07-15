import { type CSSProperties, type ReactNode, useState } from 'react'
import { colors, spacing } from '@mygames/game-ui'
import { executeDeal, executeSwap, createAuction } from '../api'
import { money } from './shared'

// ── Transactions tab (v3 §11.4 / §6–§8) — the three action forms, one row per region held.
//
// THE PASSWORD FIELD (Elena-locked, 2026-07-14): a MASKED input the COUNTERPARTY types on
// the acting team's screen. Cleared the instant it is submitted — never held in state past
// submit, never echoed, never logged (privacy-walk leg 3). Labelled "Buyer's / Partner's
// password" so it's obvious the counterparty types it, not the acting team.
//
// Every form wires straight to a deployed, tested callable — zero new economic logic. Server
// errors (non-leaking by construction) are surfaced verbatim.

type Holding = { region: string; count: number }

export default function TransactionsTab({
  myHoldings, allRegions, available, marketOpen, onActed,
}: {
  myHoldings: Holding[]
  allRegions: string[]
  available: number
  marketOpen: boolean
  onActed: () => void
}) {
  if (!marketOpen) {
    return <p style={{ color: colors.textSecondary }} data-testid="transactions-tab">
      Trading is not open right now. Forms appear when the market is open.
    </p>
  }
  if (myHoldings.length === 0) {
    return <div data-testid="transactions-tab">
      <p style={{ color: colors.textSecondary }}>You hold no licenses to trade. You can still bid on auctions from the General tab.</p>
    </div>
  }

  return (
    <div data-testid="transactions-tab">
      <div style={{ marginBottom: spacing.gapMd, fontSize: '0.9rem' }}>
        <strong>Available cash:</strong>{' '}
        <span data-testid="available-cash">{money(available)}</span>{' '}
        <span style={{ color: colors.textSecondary }}>(cash minus your live auction bids)</span>
      </div>

      <Section title="Report a License-for-Cash Transaction"
        hint="You negotiate the price verbally; record it here, then the buyer types their own password to authorize.">
        {myHoldings.map((h) => (
          <DealRow key={h.region} h={h} available={available} onActed={onActed} />
        ))}
      </Section>

      <Section title="Report a Swap"
        hint="Licenses for licenses, no cash. The partner types their own password to authorize.">
        {myHoldings.map((h) => (
          <SwapRow key={h.region} h={h} allRegions={allRegions} onActed={onActed} />
        ))}
      </Section>

      <Section title="Start an Auction"
        hint="Sealed-bid, first-price, whole lot. Optional private reserve — nobody but you ever sees it.">
        {myHoldings.map((h) => (
          <AuctionRow key={h.region} h={h} onActed={onActed} />
        ))}
      </Section>
    </div>
  )
}

// ── one deal row: region fixed; quantity / price / buyer team / buyer password ──
function DealRow({ h, available, onActed }: { h: Holding; available: number; onActed: () => void }) {
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')
  const [buyer, setBuyer] = useState('')
  const [pw, setPw] = useState('')
  const { busy, msg, err, run } = useSubmit()

  const submit = () => {
    const buyerPassword = pw
    setPw('') // clear BEFORE the await — never held past submit
    run(() => executeDeal({
      region: h.region, quantity: Number(qty), price: Number(price),
      buyerTeam: Number(buyer), buyerPassword,
    }), onActed)
  }

  return (
    <Row>
      <RegionTag region={h.region} count={h.count} />
      <NumIn label="Qty" value={qty} onChange={setQty} min={1} max={h.count} testid={`deal-qty-${h.region}`} />
      <NumIn label="Price" value={price} onChange={setPrice} min={0} testid={`deal-price-${h.region}`} />
      <NumIn label="Buyer team" value={buyer} onChange={setBuyer} min={1} testid={`deal-buyer-${h.region}`} />
      <PwIn label="Buyer's password" value={pw} onChange={setPw} testid={`deal-pw-${h.region}`} />
      <SubmitBtn onClick={submit} disabled={busy || !price || !buyer || !pw} testid={`deal-submit-${h.region}`}>Record deal</SubmitBtn>
      <Status msg={msg} err={err} />
      {Number(price) > available && <Warn>Price exceeds your available cash — you may still record it; the buyer pays, not you.</Warn>}
    </Row>
  )
}

// ── one swap row: my region X × qty ↔ partner region Y × qty ──
function SwapRow({ h, allRegions, onActed }: { h: Holding; allRegions: string[]; onActed: () => void }) {
  const [qtyX, setQtyX] = useState('1')
  const [regionY, setRegionY] = useState(allRegions.find((r) => r !== h.region) ?? '')
  const [qtyY, setQtyY] = useState('1')
  const [partner, setPartner] = useState('')
  const [pw, setPw] = useState('')
  const { busy, msg, err, run } = useSubmit()

  const submit = () => {
    const partnerPassword = pw
    setPw('')
    run(() => executeSwap({
      regionX: h.region, quantityX: Number(qtyX),
      regionY, quantityY: Number(qtyY),
      partnerTeam: Number(partner), partnerPassword,
    }), onActed)
  }

  return (
    <Row>
      <RegionTag region={h.region} count={h.count} />
      <NumIn label="Give qty" value={qtyX} onChange={setQtyX} min={1} max={h.count} testid={`swap-qtyx-${h.region}`} />
      <span style={{ alignSelf: 'flex-end', padding: '0 0.2rem 0.4rem' }}>↔</span>
      <label style={lbl}>Get region
        <select value={regionY} onChange={(e) => setRegionY(e.target.value)} style={inp} data-testid={`swap-regiony-${h.region}`}>
          {allRegions.filter((r) => r !== h.region).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <NumIn label="Get qty" value={qtyY} onChange={setQtyY} min={1} testid={`swap-qtyy-${h.region}`} />
      <NumIn label="Partner team" value={partner} onChange={setPartner} min={1} testid={`swap-partner-${h.region}`} />
      <PwIn label="Partner's password" value={pw} onChange={setPw} testid={`swap-pw-${h.region}`} />
      <SubmitBtn onClick={submit} disabled={busy || !regionY || !partner || !pw} testid={`swap-submit-${h.region}`}>Record swap</SubmitBtn>
      <Status msg={msg} err={err} />
    </Row>
  )
}

// ── one auction row: region fixed; quantity / optional reserve ──
function AuctionRow({ h, onActed }: { h: Holding; onActed: () => void }) {
  const [qty, setQty] = useState('1')
  const [reserve, setReserve] = useState('')
  const { busy, msg, err, run } = useSubmit()

  const submit = () =>
    run(() => createAuction({ region: h.region, quantity: Number(qty), reserve: reserve ? Number(reserve) : 0 }), onActed)

  return (
    <Row>
      <RegionTag region={h.region} count={h.count} />
      <NumIn label="Qty" value={qty} onChange={setQty} min={1} max={h.count} testid={`auction-qty-${h.region}`} />
      <NumIn label="Reserve (optional)" value={reserve} onChange={setReserve} min={0} testid={`auction-reserve-${h.region}`} />
      <SubmitBtn onClick={submit} disabled={busy} testid={`auction-submit-${h.region}`}>Start auction</SubmitBtn>
      <Status msg={msg} err={err} />
    </Row>
  )
}

// ── shared submit state hook (surfaces server errors verbatim) ──
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = (fn: () => Promise<unknown>, onOk: () => void) => {
    setBusy(true); setMsg(null); setErr(null)
    fn()
      .then(() => { setMsg('✓ recorded'); onOk() })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Something went wrong.'))
      .finally(() => setBusy(false))
  }
  return { busy, msg, err, run }
}

// ── presentational bits ──
function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: spacing.gapLg }}>
      <h3 style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>{title}</h3>
      <p style={{ color: colors.textSecondary, fontSize: '0.82rem', marginTop: 0, marginBottom: spacing.gapSm }}>{hint}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapSm }}>{children}</div>
    </section>
  )
}
const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', padding: '0.5rem 0.6rem', border: '1px solid #e2e6ea', borderRadius: 6 }}>{children}</div>
)
const RegionTag = ({ region, count }: { region: string; count: number }) => (
  <div style={{ alignSelf: 'flex-end', paddingBottom: '0.35rem' }}>
    <strong>Region {region}</strong> <span style={{ color: colors.textSecondary, fontSize: '0.82rem' }}>({count} held)</span>
  </div>
)
function NumIn({ label, value, onChange, min, max, placeholder, testid }: {
  label: string; value: string; onChange: (v: string) => void; min?: number; max?: number; placeholder?: string; testid: string
}) {
  return <label style={lbl}>{label}
    <input type="number" value={value} min={min} max={max} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} style={inp} data-testid={testid} />
  </label>
}
function PwIn({ label, value, onChange, testid }: { label: string; value: string; onChange: (v: string) => void; testid: string }) {
  return <label style={lbl}>{label}
    {/* MASKED. autoComplete off so browsers never store the counterparty's password. */}
    <input type="password" value={value} autoComplete="off" placeholder="•••••••"
      onChange={(e) => onChange(e.target.value)} style={inp} data-testid={testid} />
  </label>
}
const SubmitBtn = ({ onClick, disabled, children, testid }: { onClick: () => void; disabled: boolean; children: ReactNode; testid: string }) => (
  <button onClick={onClick} disabled={disabled} data-testid={testid} style={{ padding: '0.4rem 0.75rem' }}>{children}</button>
)
const Status = ({ msg, err }: { msg: string | null; err: string | null }) =>
  err ? <span style={{ color: '#c00', fontSize: '0.82rem', flexBasis: '100%' }}>{err}</span>
    : msg ? <span style={{ color: '#137333', fontSize: '0.82rem', flexBasis: '100%' }}>{msg}</span>
    : null
const Warn = ({ children }: { children: ReactNode }) => (
  <span style={{ color: '#8a6d00', fontSize: '0.8rem', flexBasis: '100%' }}>{children}</span>
)

const lbl: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.78rem', color: '#555' }
const inp: CSSProperties = { padding: '0.35rem 0.4rem', width: 110, border: '1px solid #ccc', borderRadius: 4 }
