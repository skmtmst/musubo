import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyLegacyStagingRetired } from './verify-legacy-staging-retired.mjs'

const knownRun = {
  id: 41045190082,
  status: 'queued',
  head_sha: '9a51a16fb1d736666ca1e6b88bdf140d383a66c9',
  workflow_id: 356268712,
}
const knownD1Run = {
  id: 41799880393,
  status: 'queued',
  head_sha: '47582657aa8e800e40592530d2103a94396481cb',
  workflow_id: 356268717,
}

function fakeGithub({ workflowState = 'disabled_manually', runs = [], counts = {}, jobs = 0, lock = false, failedPath = '' } = {}) {
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search
    if (path.includes(failedPath) && failedPath) return Response.json({}, { status: 503 })
    if (path.includes('/git/ref/')) return lock ? Response.json({ ref: 'refs/deploy-locks/staging' }) : Response.json({}, { status: 404 })
    if (path.includes('/jobs?')) return Response.json({ total_count: jobs })
    if (path.includes('/runs?status=queued')) {
      const workflow = path.includes('migrate-d1.yml') ? 'migrate-d1.yml' : 'deploy-cloudflare-staging.yml'
      const workflowRuns = Array.isArray(runs) ? (workflow === 'migrate-d1.yml' ? [] : runs) : (runs[workflow] ?? [])
      return Response.json({ total_count: workflowRuns.length, workflow_runs: workflowRuns })
    }
    if (path.includes('/runs?')) return Response.json({ total_count: counts[path] ?? 0 })
    return Response.json({ id: path.includes('migrate-d1.yml') ? 356268717 : 356268712, state: workflowState })
  }
}

test('旧2経路が停止し、先行実行とロックがないときだけ通る', async () => {
  await assert.doesNotReject(verifyLegacyStagingRetired(fakeGithub()))
})

test('旧配備経路が有効なら停止する', async () => {
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ workflowState: 'active' })), /無効ではありません/)
})

test('記録済みの停止runだけがジョブ未生成で残る場合は通る', async () => {
  await assert.doesNotReject(verifyLegacyStagingRetired(fakeGithub({ runs: {
    'deploy-cloudflare-staging.yml': [knownRun],
    'migrate-d1.yml': [knownD1Run],
  } })))
})

test('新しい待機runやジョブが生じた場合は停止する', async () => {
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ runs: [{ ...knownRun, id: 1 }] })), /未承認/)
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ runs: { 'migrate-d1.yml': [{ ...knownD1Run, head_sha: knownRun.head_sha }] } })), /未承認/)
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ runs: [knownRun], jobs: 1 })), /ジョブ/)
})

test('実行中・待機中がある場合は停止する', async () => {
  const path = '/repos/skmtmst/line-harness-oss/actions/workflows/deploy-cloudflare-staging.yml/runs?status=in_progress&per_page=1'
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ counts: { [path]: 1 } })), /in_progress/)
})

test('旧ロックまたはAPI障害では停止する', async () => {
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ lock: true })), /ロック/)
  await assert.rejects(verifyLegacyStagingRetired(fakeGithub({ failedPath: '/actions/workflows/' })), /確認できません/)
})
