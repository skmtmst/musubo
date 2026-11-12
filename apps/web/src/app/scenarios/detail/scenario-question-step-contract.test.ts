import { describe, expect, it } from 'vitest'

import { deadAnswerSettings, isUriOnlyBehavior, validateChoiceUris } from '../../../components/scenarios/question-editor'

/*
 * SCENARIO-21・SCENARIO-22・R214 の再発防止。
 *
 * SCENARIO-21: 直接作った質問（テンプレートを選ばない質問の通）が、
 * 保存時に「テンプレートを選択してください」で止まっていた。質問・
 * 直接入力・テンプレートの検査は独立した枝でなければならない。
 *
 * SCENARIO-22: URL・電話・メール・友だち追加・回答フォームは LINE 側で
 * 「開く」だけで、押された通知（postback）は届かない。届かないのに
 * 返信・タグ・友だち情報・選択肢アクションを設定できると、実行されると
 * 思って保存する人が出る。
 *
 * 保存前の検査（質問・直接入力・テンプレートの枝、届かない設定、行き先の形）は
 * v8/scenario-detail/step-validation.test.ts が検査の関数を呼んで守る。
 * 編集欄でアクションの入口を出さない・「実行されない設定を消す」は
 * components/scenarios/question-editor-uri-only.test.tsx が描いて守る。
 * ここでは判定の関数そのものを確かめる。
 */

describe('SCENARIO-22: URIだけの挙動に届かない設定をさせない', () => {
  it('URI だけの挙動を判定する', () => {
    for (const b of ['url', 'tel', 'mail', 'add_friend', 'form'] as const) {
      expect(isUriOnlyBehavior(b), b).toBe(true)
    }
    // postback が届く挙動は対象外。回答の処理がそのまま動く。
    for (const b of ['none', 'scenario'] as const) {
      expect(isUriOnlyBehavior(b), b).toBe(false)
    }
  })

  it('実行されない設定を名指しする', () => {
    const dead = deadAnswerSettings({
      label: '詳しく見る',
      behavior: 'url',
      url: 'https://example.com',
      reply: 'ありがとうございます',
      addTagIds: ['t1'],
      field: { fieldId: 'f1', value: 'x' },
    })
    expect(dead).toEqual(['選択時の返信', '友だち情報欄'])
    expect(deadAnswerSettings({label:'電話',behavior:'tel',addTagIds:['t1'],scoreChange:10})).toEqual(['追加するタグ','足すスコア'])
  })

  it('未設定なら何も挙げない', () => {
    expect(deadAnswerSettings({ label: '開く', behavior: 'url' })).toEqual([])
  })
})

/*
 * R214: 質問のURL選択肢に不正なURLを保存できる。
 * not-a-url のような行き先でも保存できると、設定済みに見えて
 * 実際は開けない通になる。保存時（画面）と保存口（worker）の
 * 両方で止め、正しいURLへ直せるようにする。
 */
describe('R214: 行き先の形が正しくない選択肢は保存しない', () => {
  const base = {
    text: '体調はいかがですか？',
    tapMode: 'single' as const,
  }

  it('URLを開くに not-a-url は止める', () => {
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: '見る', behavior: 'url', url: 'not-a-url' }],
      }),
    ).toContain('選択肢1のURL')
  })

  it('正しい https のURLは通す', () => {
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: '見る', behavior: 'url', url: 'https://example.com/a' }],
      }),
    ).toBeNull()
  })

  it('電話・メールも形を見る', () => {
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: '電話', behavior: 'tel', tel: 'abc' }],
      }),
    ).toContain('選択肢1の電話番号')
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: 'メール', behavior: 'mail', email: 'not-an-email' }],
      }),
    ).toContain('選択肢1のメールアドレス')
    expect(
      validateChoiceUris({
        ...base,
        choices: [
          { label: '電話', behavior: 'tel', tel: '03-0000-5678' },
          { label: 'メール', behavior: 'mail', email: 'a@example.com' },
        ],
      }),
    ).toBeNull()
  })

  it('行き先が空のままも通さない', () => {
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: '見る', behavior: 'url', url: '' }],
      }),
    ).toContain('選択肢1のURL')
  })

  it('挙動が「何もしない」なら行き先は見ない', () => {
    expect(
      validateChoiceUris({
        ...base,
        choices: [{ label: 'はい', behavior: 'none' }],
      }),
    ).toBeNull()
  })
})
