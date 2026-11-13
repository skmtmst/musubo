import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = readApiSource(join(HERE, '../../lib/api.ts'), 'utf8')
const PAGE = readUiSource(join(HERE, 'page.tsx'), 'utf8')
const OVERVIEWS = ['outgoing', 'incoming'].map(name => readUiSource(join(import.meta.dirname, '../../v8/webhooks', `${name}.tsx`), 'utf8')).join('\n')

describe('V8 外部連携の接続別集計と受信口詳細', () => {
  it('送信一覧を接続別集計つきの型で受け取る', () => {
    expect(API).toContain('export type OutgoingWebhookOverview = OutgoingWebhook &')
    expect(API).toContain('deliverySummary: {')
    expect(API).toContain("status: 'succeeded' | 'failed' | 'pending'")
    expect(API).toContain('fetchApi<ApiResponse<OutgoingWebhookOverview[]>>')
    expect(PAGE).toContain('useState<OutgoingWebhookOverview[]>([])')
  })

  it('送信回数・失敗・再送可否を画面へ反映する', () => {
    expect(OVERVIEWS).toContain('formatNumber(item.deliverySummary.total)')
    expect(OVERVIEWS).toContain('item.deliverySummary.failed > 0')
    expect(OVERVIEWS).toContain('item.deliverySummary.canRetry')
    expect(OVERVIEWS).toContain("item.deliverySummary.lastResult?.status === 'pending'")
    expect(OVERVIEWS).toContain('return !pending &&')
    expect(OVERVIEWS).toContain("view.sort === 'volume' ? 'volume' : 'name'")
    expect(OVERVIEWS).toContain('送った回数が多い順')
    expect(OVERVIEWS).not.toContain('接続別集計待ち')
  })

  it('送信先へテスト送信できる', () => {
    expect(API).toContain('/api/webhooks/outgoing/${encodeURIComponent(id)}/test')
    // d23b R421: 開始時点のアカウントを固定して送る（切替後の誤送信防止）。
    expect(OVERVIEWS).toContain('accountRef.current !== accountId')
    expect(OVERVIEWS).toContain('試しに送る')
    expect(OVERVIEWS).toContain('item.deliverySummary.canRetry && canManage')
    expect(OVERVIEWS).toContain('<RowMenu')
    expect(OVERVIEWS).toContain('open={menuId === item.id}')
  })

  it('選んだ受け取り口の詳細をアカウント付きで取得する', () => {
    expect(API).toContain('/api/webhooks/incoming/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}')
    expect(PAGE).toContain('api.webhooks.incoming.detail(selectedDetailId, selectedAccountId)')
    expect(OVERVIEWS).toContain('api.webhooks.incoming.detail(selectedDetailId, selectedAccountId)')
    expect(OVERVIEWS).toContain('if (cancelled) return')
  })

  it('照合・処理名・マスク済み見本・差し込み項目だけを表示する', () => {
    expect(OVERVIEWS).toContain('identityMatchingLabel(detail)')
    expect(OVERVIEWS).toContain('incomingActionLabel(action.refKind)')
    expect(OVERVIEWS).toContain('{action.displayName}')
    expect(OVERVIEWS).toContain('maskedSampleText(detail.latestSample.fields)')
    expect(OVERVIEWS).toContain('detail.templateFields.map((field) => field.token)')
    expect(readFileSync(join(HERE, '../../v8/webhooks/incoming.tsx'), 'utf8')).not.toContain('{action.refId}')
    expect(OVERVIEWS).not.toContain('照合方法のAPI待ち')
    expect(OVERVIEWS).not.toContain('最近届いた本文を安全にマスクして返すAPIがまだありません')
  })

  it('詳細取得に失敗しても一覧を消さず、詳細だけ再読込できる', () => {
    expect(OVERVIEWS).toContain("setDetailStatus('error')")
    expect(OVERVIEWS).toContain('届いた後の処理を表示できませんでした')
    expect(OVERVIEWS).toContain('setDetailReloadKey((key) => key + 1)')
  })
})
