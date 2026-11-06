import { pathToFileURL } from 'node:url'

const LEGACY_REPOSITORY = 'skmtmst/line-harness-oss'
const WORKFLOWS = ['deploy-cloudflare-staging.yml', 'migrate-d1.yml']
const ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting']
const API_ROOT = `https://api.github.com/repos/${LEGACY_REPOSITORY}`

async function githubJson(path, fetcher, allowMissing = false) {
  const response = await fetcher(`${API_ROOT}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
  })
  if (allowMissing && response.status === 404) return null
  if (!response.ok) throw new Error(`旧配備経路の状態を確認できません（HTTP ${response.status}: ${path}）。`)
  return response.json()
}

/** A legacy workflow may still publish after a repository switch unless it is retired and empty. */
export async function verifyLegacyStagingRetired(fetcher = fetch) {
  for (const workflow of WORKFLOWS) {
    const path = `/actions/workflows/${workflow}`
    const metadata = await githubJson(path, fetcher)
    if (metadata?.state !== 'disabled_manually') {
      throw new Error(`旧 ${workflow} が無効ではありません。新リポジトリからの配備を停止します。`)
    }
    for (const status of ACTIVE_STATUSES) {
      const runs = await githubJson(`${path}/runs?status=${status}&per_page=1`, fetcher)
      if (!Number.isInteger(runs?.total_count) || runs.total_count !== 0) {
        throw new Error(`旧 ${workflow} に ${status} の実行が残るか件数不明です。新リポジトリからの配備を停止します。`)
      }
    }
  }
  const lock = await githubJson('/git/ref/deploy-locks/staging', fetcher, true)
  if (lock !== null) throw new Error('旧共有検証ロックが残っています。新リポジトリからの配備を停止します。')
  console.log('旧配備・D1更新経路は無効、先行実行0件、旧ロックなし。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyLegacyStagingRetired()
}
