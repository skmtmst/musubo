import { pathToFileURL } from 'node:url'

const LEGACY_REPOSITORY = 'skmtmst/line-harness-oss'
const WORKFLOWS = ['deploy-cloudflare-staging.yml', 'migrate-d1.yml']
const ACTIVE_STATUSES = ['in_progress', 'waiting', 'requested', 'pending', 'action_required']
const API_ROOT = `https://api.github.com/repos/${LEGACY_REPOSITORY}`

// GitHub reports these runs as queued, but cancel and force-cancel both return 409
// ("has not been queued yet"). Each has zero jobs and predates the published
// staging source. The legacy staging workflow is disabled and its only
// Cloudflare API token was removed from the staging Environment. The operator
// check and date are recorded in docs/deploy/musubo-staging-cutover.md.
// This list is an exact allowlist, not a general exception for queued runs.
const STALLED_RUNS = {
  'deploy-cloudflare-staging.yml': new Map([
    [41045190082, '9a51a16fb1d736666ca1e6b88bdf140d383a66c9'],
    [41041962168, '518fc99f31a64ff1b737e77f2e8d516f8bec78cc'],
    [40832194668, 'b6202f60adb36b8cd8e33af202539404a3853aab'],
    [40804181814, '02b96728caeb654066176e756ab6dbbfc7e952ea'],
    [40796327597, '9c7b23b0b0c4a0a24e3aa71df96956c8870de08e'],
    [40682929863, '7a17ae7d7061f7cdb39c463923e53828e9748958'],
  ]),
  'migrate-d1.yml': new Map([
    [41799880393, '47582657aa8e800e40592530d2103a94396481cb'],
    [40635554299, '58d801b35e27bea2dab5a29e8a673ed9865ce08b'],
  ]),
}

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

/** Permit only the documented, jobless GitHub-stuck runs after legacy credentials are retired. */
export async function verifyLegacyStagingRetired(fetcher = fetch) {
  for (const workflow of WORKFLOWS) {
    const path = `/actions/workflows/${workflow}`
    const metadata = await githubJson(path, fetcher)
    if (metadata?.state !== 'disabled_manually') {
      throw new Error(`旧 ${workflow} が無効ではありません。新リポジトリからの配備を停止します。`)
    }
    const queued = await githubJson(`${path}/runs?status=queued&per_page=100`, fetcher)
    const allowed = STALLED_RUNS[workflow]
    if (!Number.isInteger(queued?.total_count) || !Array.isArray(queued.workflow_runs) ||
        queued.total_count !== queued.workflow_runs.length || queued.total_count > allowed.size) {
      throw new Error(`旧 ${workflow} の待機実行を全件照合できません。新リポジトリからの配備を停止します。`)
    }
    for (const run of queued.workflow_runs) {
      if (run?.status !== 'queued' || allowed.get(run.id) !== run.head_sha ||
          run.workflow_id !== metadata.id) {
        throw new Error(`旧 ${workflow} に未承認の queued 実行があります。新リポジトリからの配備を停止します。`)
      }
      const jobs = await githubJson(`/actions/runs/${run.id}/jobs?per_page=1`, fetcher)
      if (jobs?.total_count !== 0) {
        throw new Error(`旧 ${workflow} の queued 実行 ${run.id} にジョブが生じました。新リポジトリからの配備を停止します。`)
      }
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
  console.log('旧配備・D1更新経路は無効。既知のジョブ未生成run以外の先行実行と旧ロックはありません。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyLegacyStagingRetired()
}
