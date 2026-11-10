import test from 'node:test'
import assert from 'node:assert/strict'
import { plannedCorsRules } from './staging-r2-cors.mjs'

const existing = [{
  allowed: {
    origins: ['https://nen-line-stg-admin.pages.dev'],
    methods: ['PUT'],
    headers: ['Content-Type', 'x-amz-meta-line-account-id', 'x-amz-meta-upload-session-id'],
  },
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
}]

test('現行の署名PUTルールを保ち、管理画面のOriginだけを加える', () => {
  const next = plannedCorsRules(existing)
  assert.deepEqual(next[0].allowed.origins, [
    'https://nen-line-stg-admin.pages.dev',
    'https://stg-admin.musubo.jp',
  ])
  assert.deepEqual(next[0].allowed.headers, existing[0].allowed.headers)
  assert.deepEqual(existing[0].allowed.origins, ['https://nen-line-stg-admin.pages.dev'])
  assert.deepEqual(plannedCorsRules(next), next)
})

test('想定外の既存設定は上書きしない', () => {
  assert.throws(() => plannedCorsRules([]), /想定と違います/)
  assert.throws(() => plannedCorsRules([{ ...existing[0], exposeHeaders: [] }]), /想定と違います/)
  assert.throws(() => plannedCorsRules([{ ...existing[0], allowed: { ...existing[0].allowed, origins: ['*'] } }]), /想定と違います/)
})
