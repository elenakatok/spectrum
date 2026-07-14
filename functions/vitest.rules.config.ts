import { defineConfig } from 'vitest/config'

// Config for the emulator-backed rules tests ONLY. Unlike the default config it
// does NOT exclude *.emulator.test.ts. Used by `npm run test:rules`, which boots
// the Firestore emulator first (via firebase emulators:exec).
export default defineConfig({
  test: {
    include: ['test/**/*.emulator.test.ts'],
  },
})
