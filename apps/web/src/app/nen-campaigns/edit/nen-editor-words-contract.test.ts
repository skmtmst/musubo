import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const EDITOR = fs.readFileSync(path.join(__dirname, '../../../v8/nen-campaigns/edit.tsx'), 'utf8')

describe('V8 NEN配信編集の運用者向け文言契約', () => {
  it('きっかけの内部値を画面へ出さない', () => {
    expect(EDITOR).not.toContain("{setting.triggerEvent ?? '手動で送る'}")
  })

  it('画面名をNEN配信にそろえ、内部エラーを表示しない', () => {
    // 現役の共通画面の見出しと、一覧へ戻る操作を見張る。
    expect(EDITOR).not.toContain('Header title=')
    expect(EDITOR).not.toContain('フォロー配信へ戻る')
    expect(EDITOR).not.toContain('setError(e instanceof Error ? e.message')
  })

  it('本文エディタと回答フォーム・200マイルの送信後アクションを表示して保存する', () => {
    expect(EDITOR).toContain('InsertToolbar')
    /*
     * NEXT-16 (#989): 複数吹き出しはWorkerの保存スキーマに口がない。
     * 無反応の「差し替える」「消す」「吹き出しを追加する」は出さず、
     * 1通で届くことを明示する。
     */
    expect(EDITOR).not.toContain('吹き出しを追加する')
    expect(EDITOR).not.toContain('<Button>差し替える</Button>')
    expect(EDITOR).toContain('回答フォームを開かせる <OptionalBadge />')
    expect(EDITOR).toContain('value={formAction?.formId')
    expect(EDITOR).toContain('const MILEAGE_CHOICES = [50, 100, 200, 300, 500, 1000]')
    expect(EDITOR).toContain("{ kind: 'award_mileage', amount: Number(value), trigger: 'form_submitted' }")
    expect(EDITOR).toContain('afterActions: actions')
    expect(EDITOR).toContain('配信内容を保存する')
  })
})
