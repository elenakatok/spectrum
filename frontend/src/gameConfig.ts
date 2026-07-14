import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

// SINGLE-ROLE — mirrors functions/src/gameDefinition.ts. One role `trader`. The outcome
// schema is a PLACEHOLDER (one dummy field); the live trading market replaces it in
// Slices 1–5 (Spectrum_Build_Plan_v1.md). PHASE A SKELETON.

export const spectrumConfig: RoleConfig = {
  roles: [
    { key: 'trader', label: 'Trader', short: 'T' },
  ],
}

// Outcome schema — mirrors functions/src/gameDefinition.ts. Placeholder; ignored by scoring.
export const spectrumSchema: OutcomeSchema = [
  { key: 'placeholder', type: 'decimal', min: 0, max: 1_000_000, step: 1 },
]

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  placeholder: 'Placeholder',
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'integer') return (value as number).toLocaleString('en-US')
  if (field.type === 'decimal') return (value as number).toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (field.type === 'enum')    return value as string
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  return String(value)
}
