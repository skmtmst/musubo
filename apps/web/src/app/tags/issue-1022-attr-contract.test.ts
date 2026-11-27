import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeSavedCondition } from '@/components/friends/saved-search-utils'

const root = resolve(process.cwd(), 'src')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

/*
 * IDEA-04（issue #1022）：タグの分類説明・重複候補・変更前後条件。
 *
 * 実施範囲：
 *  - 既存の属性作成／編集で、タグ・情報欄・対応マーク等の違いを説明する
 *  - 重複候補と利用先を示す
 *  - 設定変更で対象人数が変わる場合、変更前後の条件・計算時点を表示する
 *  - 大量対象の影響計算が間に合わないときは「未計算」、推定は確定値にしない
 *  - 属性辞書の独立メニュー・自動統合・新しいタイトルバーは作らない
 */
describe('IDEA-04（issue #1022）タグの分類説明・重複候補・変更前後条件', () => {
  it('分類案内は情報欄の作成先を持つ', () => {
    const guide = read('components/friend-fields/attribute-kind-guide.tsx')
    // 作る入口は既存画面だけ。独立した属性辞書メニューは作らない。
    expect(guide).toContain("createHref: '/tags/fields/new'")
  })

  it('4つの作成・編集画面すべてに分類案内と重複名の注意がある', () => {
    const cases: Array<{ file: string; kind: string; label: string }> = [
      { file: 'v8/tag-edit/edit-form.tsx', kind: 'tag', label: 'タグ' },
      { file: 'app/tags/fields/new/page.tsx', kind: 'field', label: '項目' },
      { file: 'app/tags/fields/edit/page.tsx', kind: 'field', label: '項目' },
      { file: 'v8/tags/mark-editor.tsx', kind: 'mark', label: '対応マーク' },
      { file: 'app/tags/searches/edit/page.tsx', kind: 'search', label: '保存した検索' },
    ]
    for (const { file, kind, label } of cases) {
      const source = read(file)
      if (kind === 'tag') {
        for (const text of ['タグは分類の目印', '友だち情報欄は', '対応マークは対応の状態', '保存した検索は']) expect(source).toContain(text)
      }
      else expect(source, `${file} に分類案内が無い`).toContain(`<AttributeKindGuide current="${kind}" />`)
      expect(source, `${file} に重複名の注意が無い`).toContain('DuplicateNameNote')
      expect(source, `${file} の重複名判定が自分自身を外していない`).toContain('findDuplicateNames')
      expect(source, `${file} の重複名の呼び名`).toContain(`kindLabel="${label}"`)
    }
  })

  it('タグ一覧は重複名の整理候補を行ごとに示す', () => {
    const source = read('v8/tags/tags-tab.tsx')
    // サーバーの cleanupReasons だけを見る。画面で再判定しない。
    expect(source).toContain("tag.cleanupReasons?.includes('duplicate_name')")
    expect(source).toContain('名前が重なっている')
    expect(source).toContain('<StatusBadge size="annotation" tone="warning"')
  })

  it('タグ編集はHQ埋め込みではストアの一覧を読まず、同名だけを注意する', () => {
    const source = read('v8/tag-edit/edit-form.tsx')
    // embedded（HQ定義エディタ）ではストアのタグ一覧を読まない。
    expect(source).toContain('if (host) return')
    expect(read('v8/hq-templates/tag-editor.tsx')).toContain('accountId=""')
    // 保存を止めない注意。サーバーの一意制約が最終判断。
    expect(read('components/friend-fields/attribute-kind-guide.tsx')).toContain('一覧の重複名の整理候補')
  })

  it('保存した検索の編集は計算時点と変更前後の条件を出す', () => {
    const source = read('app/tags/searches/edit/page.tsx')
    // 計算時点。APIの calculatedAt をそのまま出し、取れないときは出さない。
    expect(source).toContain('preview?.calculatedAt')
    expect(source).toContain('に数えた数')
    // 条件を変えたあとは「変更前の条件の人数」と「変えたあとの条件はまだ数えていません」を分ける。
    expect(source).toContain('変えたあとの条件はまだ数えていません')
    expect(source).toContain('変える前：')
    expect(source).toContain('変えたあと：')
    // 変更前後は一覧と同じ言葉（describeSavedCondition 経由）で出す。
    expect(source).toContain('savedSearchSummary(original.conditions')
    expect(source).toContain('savedSearchSummary(conditions')
    // 未計算を推定で埋めない。人数は previewCount が無ければ —（監査6 #674: MetricValue が出す）。
    expect(source).toContain("previewCount === null ? <span className={styles.countNum}>{emptyValue('unknown')}</span>")
  })

  it('条件の言語化は編集画面が作れる演算子をすべて正しく説明する', () => {
    // IDEA-04: 変更前後の条件をそのまま読める形で出すには、
    // 編集画面が作れる10演算子の呼び分けが要る。
    expect(describeSavedCondition({ kind: 'field', key: 'age', op: 'gte', value: '20' }, [], { fields: { age: '年齢' } }))
      .toBe('年齢 が次以上「20」')
    expect(describeSavedCondition({ kind: 'field', key: 'age', op: 'lt', value: '65' }, [], { fields: { age: '年齢' } }))
      .toBe('年齢 がより小さい「65」')
    expect(describeSavedCondition({ kind: 'field', key: 'pet', op: 'contains', value: '犬' }, [], { fields: { pet: 'ペット' } }))
      .toBe('ペット が次を含む「犬」')
    expect(describeSavedCondition({ kind: 'field', key: 'pet', op: 'exists' }, [], { fields: { pet: 'ペット' } }))
      .toBe('ペット が登録あり')
    expect(describeSavedCondition({ kind: 'field', key: 'pet', op: 'not_exists' }, [], { fields: { pet: 'ペット' } }))
      .toBe('ペット が未登録')
    // 旧形式の互換名（has/not_has/equals/not_equals）も誤った極性で出さない。
    expect(describeSavedCondition({ kind: 'tag', op: 'not_has', value: 't1' }))
      .toBe('タグ を含まない「選択済みのタグ」')
    expect(describeSavedCondition({ kind: 'tag', op: 'has', value: 't1' }))
      .toBe('タグ を含む「選択済みのタグ」')
    expect(describeSavedCondition({ kind: 'field', key: 'f', op: 'not_equals', value: 'x' }))
      .toBe('選択済みの友だち情報 が次と異なる「x」')
    // 名前・ステータスメッセージの完全一致は「が」、含むは「に」。
    expect(describeSavedCondition({ kind: 'name', op: 'eq', value: '田中' })).toBe('名前が「田中」')
    expect(describeSavedCondition({ kind: 'status_message', op: 'contains', value: '連絡' }))
      .toBe('ステータスメッセージに「連絡」を含む')
    // 存在確認の否定形は「無い」。「ある」で出すと逆の意味になる。
    expect(describeSavedCondition({ kind: 'event_booking', op: 'not_exists' })).toBe('イベント予約がない')
    expect(describeSavedCondition({ kind: 'memo', op: 'not_exists' })).toBe('メモがない')
    expect(describeSavedCondition({ kind: 'memo', op: 'eq', value: '要対応' })).toBe('メモが「要対応」')
    expect(describeSavedCondition({ kind: 'assignee', op: 'ne', value: 's1' }))
      .toBe('担当者が「選択済みの担当者」以外')
  })

  it('新しいタイトルバーや属性辞書メニューは増えていない', () => {
    // ガイドは共通部品 shared/ ではなく属性エリア内に置く。
    const guide = read('components/friend-fields/attribute-kind-guide.tsx')
    expect(guide).not.toContain('PageHeader')
    for (const file of [
      'components/friend-fields/tag-editor-v4.tsx',
      'app/tags/fields/new/page.tsx',
      'app/tags/fields/edit/page.tsx',
      'v8/tags/mark-editor.tsx',
      'app/tags/searches/edit/page.tsx',
      'components/friend-fields/attribute-kind-guide.tsx',
      'components/friend-fields/tags-page-v4.tsx',
    ]) {
      expect(read(file), `${file} に禁止語`).not.toContain('準備中')
    }
  })
})
