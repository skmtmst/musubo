import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function nextVersion(manifest, lock) {
  const declared = JSON.parse(manifest).dependencies?.next
  const importer = lock.match(/^  apps\/web:\s*\n([\s\S]*?)(?=^  [^ \n][^\n]*:\s*$|\npackages:\s*$)/m)?.[1]
  const resolved = importer?.match(/^      next:\s*\n        specifier: (.+)\n        version: (.+)$/m)
  if (typeof declared !== 'string' || !resolved) throw new Error('Cannot determine apps/web Next.js version from manifest and lockfile')
  return JSON.stringify([declared, resolved[1].trim(), resolved[2].trim().split('(')[0]])
}

export function changed(base, head) {
  const read = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' })
  return nextVersion(read(base, 'apps/web/package.json'), read(base, 'pnpm-lock.yaml')) !==
    nextVersion(read(head, 'apps/web/package.json'), read(head, 'pnpm-lock.yaml'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Expected base and head SHA')
  console.log(changed(process.argv[2], process.argv[3]))
}
