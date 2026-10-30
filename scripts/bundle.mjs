// Bundles src/cli.ts into a single ESM file (dist/agent.mjs) with the version baked in.
import { build } from 'esbuild'
import { readFileSync, mkdirSync, chmodSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = process.env.VERSION || pkg.version
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/agent.mjs',
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: 'info'
})
chmodSync('dist/agent.mjs', 0o755)
console.log(`bundled logship-print-agent ${version} → dist/agent.mjs`)
