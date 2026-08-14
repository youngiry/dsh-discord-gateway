import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  clean: true,
  dts: true,
  // Server-side bundle: keep every package external (dsh peer deps + discord.js
  // resolve from the profile's node_modules at runtime, never inlined).
  external: [/^@deepseek-ai\//, /^discord\.js/, /^node:/],
})
