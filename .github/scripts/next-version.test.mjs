import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextVersion } from './next-version.mjs'

const manifest = version => JSON.stringify({ dependencies: { next: version } })
const lock = (version, peer = 'react@19') => `importers:\n  apps/web:\n    dependencies:\n      next:\n        specifier: ^15.0.0\n        version: ${version}(${peer})\n      react:\n        version: 19\n  apps/worker:\n    dependencies: {}\n\npackages:\n`
test('Next.js の解決版・指定版の変更を検出する', () => {
  const before = nextVersion(manifest('^15.0.0'), lock('15.5.1'))
  assert.notEqual(before, nextVersion(manifest('^15.0.0'), lock('15.5.2')))
  assert.notEqual(before, nextVersion(manifest('^16.0.0'), lock('15.5.1')))
  assert.equal(before, nextVersion(manifest('^15.0.0'), lock('15.5.1', 'react@20')))
  assert.throws(() => nextVersion(manifest('^15.0.0'), 'invalid'))
})

test('workflow は変更判定後に既存の全幅検査を起動する', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync('.github/workflows/required-pr-gate.yml', 'utf8')
  assert.match(workflow, /next_changed=\$\(node \.github\/scripts\/next-version\.mjs/)
  assert.match(workflow, /if \[ "\$next_changed" = "true" \]; then[\s\S]*?echo "run=true"/)
  assert.match(workflow, /No V8 layout breaks at 1152, 1440 and 1920[\s\S]*?layout-overflow\.mjs/)
  const browserEnv = readFileSync('apps/web/scripts/v8-guard/browser-env.mjs', 'utf8')
  assert.match(browserEnv, /WIDTHS\s*=\s*\[[^\]]*1152[^\]]*1440[^\]]*1920/)
})
