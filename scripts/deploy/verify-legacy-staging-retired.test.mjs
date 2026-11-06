import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyLegacyStagingRetired } from './verify-legacy-staging-retired.mjs'

function fakeGithub({ workflowState = 'disabled_manually', counts = {}, lock = false, failedPath = '' } = {}) {
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    if (path.includes(failedPath) && failedPath) return Response.json({}, { status: 503 })
    if (path.includes('/git/ref/')) return lock ? Response.json({ ref: 'refs/deploy-locks/staging' }) : Response.json({}, { status: 404 })
    if (path.includes('/runs?')) return Response.json({ total_count: counts[path] ?? 0 })
    return Response.json({ state: workflowState })
  }
}

test('旧2経路が停止し、先行実行とロックがないときだけ通る', async () => {
  await assert.doesNotReject(verifyLegacyStagingRetired(fakeGithub()))
})

test('旧配備経路が有効なら停止する', async () => {
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ workflowState: 'active' })), /無効ではありません/)
})

test('旧待機ジョブがある場合は停止する', async () => {
  const path = '/repos/skmtmst/line-harness-oss/actions/workflows/deploy-cloudflare-staging.yml/runs?status=queued&per_page=1'
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ counts: { [path]: 1 } })), /queued/)
})

test('旧ロックまたはAPI障害では停止する', async () => {
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ lock: true })), /ロック/)
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ failedPath: '/actions/workflows/' })), /確認できません/)
})
