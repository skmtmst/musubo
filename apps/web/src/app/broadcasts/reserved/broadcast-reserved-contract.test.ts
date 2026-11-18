import { readUiSource } from '../../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('page.tsx', import.meta.url), 'utf8') + readFileSync(new URL('../../../v8/broadcast-detail/reserved.tsx', import.meta.url), 'utf8')
const FORM = readUiSource(join(process.cwd(), 'src/components/broadcasts/broadcast-form.tsx'), 'utf8')
const NEW_PAGE = readFileSync(join(process.cwd(), 'src/app/broadcasts/new/page.tsx'), 'utf8')

describe("管理画面 一斉配信の予約完了", () => {
  it('作成結果の実IDを完了画面へ渡す', () => {
    expect(FORM).toContain('await persistDraft(')
    expect(FORM).toContain('scheduledAtIso(),')
    expect(FORM).toContain('onSuccess(saved)')
    expect(NEW_PAGE).toContain('/broadcasts/reserved?id=')
    expect(NEW_PAGE).toContain("broadcast.status === 'scheduled'")
  })

  it('テスト送信と最終予約は同じ下書きを更新する', () => {
    expect(FORM).toContain('const draft = await persistDraft(null, true)')
    expect(FORM).toContain('api.broadcasts.testSend(draft.id)')
    expect(FORM).not.toContain('idempotencyKey: crypto.randomUUID()')
  })

  it('保存した配信を読み直し予約状態を確かめる', () => {
    expect(PAGE).toContain('api.broadcasts.get(id)')
    expect(PAGE).toContain("broadcast.status !== 'scheduled'")
    expect(PAGE).toContain('!broadcast.scheduledAt')
  })

  it('予約人数を保存値や固定値で作らず現在の見込みとして表示する', () => {
    /*
      **保存した数を出さない。** 予約してから配信までに友だちが増減するので、
      いま数え直した見込みを出す。
    */
    expect(PAGE).toContain('api.broadcasts.preflight')
    expect(PAGE).toContain('const audienceCount = estimate?.audienceCount ?? null')
    expect(PAGE).not.toContain('totalCount')
  })

  it('未取得と実値0を分ける', () => {
    expect(PAGE).toContain('formatNumber(estimate.hiddenExcluded')
  })

  it('選択中アカウントと所属先が違う配信を表示しない', () => {
    expect(PAGE).toContain('belongsToAccount(broadcast, selectedAccountId)')
  })

  it('遲れて返った別の予約の結果で画面を上書きしない', () => {
    expect(PAGE).toContain('const requestGeneration = useRef(0)')
    expect(PAGE).toContain('requestGeneration.current === generation')
    expect(PAGE).toContain('if (!isCurrent()) return')
    expect(PAGE).toContain('requestGeneration.current += 1')
    expect(PAGE).toContain('if (isCurrent()) setLoading(false)')
  })

  it('予約した内容を実値で読み合わせる', () => {
    expect(PAGE).toContain('const scheduledLabel = formatJst(broadcast.scheduledAt)')
  })

  it('予約後の操作は本物のAPIまたは実在する画面へつなぐ', () => {
    expect(PAGE).toContain('api.broadcasts.testSend(broadcast.id)')
    expect(PAGE).toContain('api.broadcasts.create({')
    expect(PAGE).toContain("duplicateKey.current ??= crypto.randomUUID()")
  })

  it('予約取消は確認後に専用の競合防止APIへ渡す', () => {
    /* **取り消せるのは、まだ送り始めていない予約だけ。** */
    expect(PAGE).toContain("const canCancel = canEdit && broadcast.status === 'scheduled' && !cancelled")
    /* 口の返事をそのまま出さない。409 も通信の失敗も、やることは同じ。 */
    expect(PAGE).not.toMatch(/setCancelError\(\s*(res\.error|String\()/)
    expect(PAGE).not.toContain('api.broadcasts.delete(broadcast.id)')
  })
})
