import { defineConfig, configDefaults } from 'vitest/config'

// The default `npm test` (vitest run) stays emulator-free: pure unit tests only.
// Emulator-backed rules tests (*.emulator.test.ts) run via `npm run test:rules`,
// which boots the Firestore emulator first.
export default defineConfig({
  test: {
    // Only the TS sources under src/ are tests — never the compiled lib/ output (tsc emits
    // CommonJS there, which vitest can't import). tsconfig now excludes *.test.ts from the
    // build; 'lib/**' also ignores any stale pre-existing copies.
    exclude: [...configDefaults.exclude, '**/*.emulator.test.ts', 'lib/**'],
  },
})
