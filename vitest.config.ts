import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// WxtVitest wires WXT's auto-imports (defineContentScript, storage, …) and swaps
// the `browser` global for @webext-core/fake-browser, so lib/ modules and even
// entrypoint files import cleanly under vitest.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
