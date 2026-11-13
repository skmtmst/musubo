import { describe, expect, it } from 'vitest'
import { COMMON_VAR_VALUE_REQUIRED, commonVarValueError, isSecretLikeVarValue } from './common-vars'

/*
 * VAR-06: 新規・編集・代替値・更新予約の送信前検査。
 * 判定は worker の normalizeCommonVarValue（packages/db/src/common-vars.ts）
 * と同じ条件——画面で先に止めて理由を出し、400の「保存に失敗しました」に
 * 置き換わらないようにする。
 */
describe('commonVarValueError（送信前の型検査）', () => {
  it('空欄不可の種別は空を理由つきで止める', () => {
    expect(COMMON_VAR_VALUE_REQUIRED.has('boolean')).toBe(true)
    expect(COMMON_VAR_VALUE_REQUIRED.has('date')).toBe(true)
    expect(COMMON_VAR_VALUE_REQUIRED.has('datetime')).toBe(true)
    // 空欄を許す種別は必須にしない（「空のまま」絞り込みが存在するため）。
    expect(COMMON_VAR_VALUE_REQUIRED.has('text')).toBe(false)
    expect(COMMON_VAR_VALUE_REQUIRED.has('number')).toBe(false)
    expect(COMMON_VAR_VALUE_REQUIRED.has('image')).toBe(false)

    expect(commonVarValueError('boolean', '')).toBe('値を選んでください')
    expect(commonVarValueError('date', '')).toBe('値の日付を入力してください')
    expect(commonVarValueError('datetime', '')).toBe('値の日時を入力してください')
  })

  it('型に合う値は通し、合わない値は理由を返す', () => {
    expect(commonVarValueError('boolean', 'true')).toBeNull()
    expect(commonVarValueError('boolean', 'false')).toBeNull()
    expect(commonVarValueError('boolean', 'yes')).toBe('値は種別に合う値を入力してください')
    expect(commonVarValueError('date', '2028-02-29')).toBeNull()
    expect(commonVarValueError('date', '2026-02-30')).toContain('実在する日付')
    expect(commonVarValueError('datetime', '2028-02-29T23:59')).toBeNull()
    expect(commonVarValueError('datetime', '2026-02-30T24:00')).toContain('実在する日時')
  })

  it('画像は https URL だけを受ける（VAR-03）', () => {
    expect(commonVarValueError('image', '')).toBeNull()
    expect(commonVarValueError('image', 'https://cdn.example.com/logo.png')).toBeNull()
    expect(commonVarValueError('image', 'not-an-image')).toContain('https://')
    expect(commonVarValueError('image', 'http://example.com/a.png')).toContain('https://')
  })

  it('URL型は http/https のURLだけを受ける（R36）', () => {
    expect(commonVarValueError('url', '')).toBeNull()
    expect(commonVarValueError('url', 'https://example.com/shop')).toBeNull()
    expect(commonVarValueError('url', 'http://example.com/shop')).toBeNull()
    // 監査で保存できてしまった文章は止める。
    expect(commonVarValueError('url', 'これはURLではありません')).toContain('http://')
    expect(commonVarValueError('url', 'ftp://example.com/a')).toContain('http://')
    expect(commonVarValueError('url', 'example.com/a')).toContain('http://')
    expect(commonVarValueError('url', 'https://')).toContain('http://')
  })

  it('代替値・更新後の値では呼び名を変えて同じ判定をする', () => {
    expect(commonVarValueError('boolean', 'yes', '代替値'))
      .toBe('代替値は種別に合う値を入力してください')
    expect(commonVarValueError('datetime', '', '更新後の値'))
      .toBe('更新後の値の日時を入力してください')
  })

  it('文字数の上限はサーバと同じ（標準200・長文10,000）', () => {
    expect(commonVarValueError('text', 'あ'.repeat(200))).toBeNull()
    expect(commonVarValueError('text', 'あ'.repeat(201))).toContain('200文字')
    expect(commonVarValueError('long_text', 'あ'.repeat(10_000))).toBeNull()
    expect(commonVarValueError('long_text', 'あ'.repeat(10_001))).toContain('10,000文字')
  })
})

/*
 * Q: 秘密らしい値は共通情報へ置かせない。判定はサーバの isSecretLikeValue
 * と同じもの——画面側はAPIを呼ぶ前に欄へ戻すためだけの前段。
 */
describe('isSecretLikeVarValue（秘密値の見立て・Q）', () => {
  it('有名な鍵の形と長い乱数を止める', () => {
    // 鍵の形の文字列はリポジトリの秘匿情報スキャンに引っかかるため、
    // 断片を連結して組み立てる。判定は組み立て後の文字列で行う。
    for (const secret of [
      ['sk', 'live', 'fakefake12345'].join('_'),
      'AKIA' + 'FAKEFAKEFAKE1234',
      'xoxb-' + '123456789012-ABCDEFGHIJKLM',
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      'Xk9#mP2$vL8&qR4!nW7@tY3*uI6pO1sD5fGh',
    ]) {
      expect(isSecretLikeVarValue(secret), secret).toBe(true)
    }
  })

  it('普通の案内文・URL・電話番号は通す', () => {
    for (const normal of [
      '営業時間 10:00-19:00',
      'https://example.com/shop/notice?campaign=autumn2026',
      '03-0000-5678',
      '株式会社サンプル',
      '利用規約を更新しました。'.repeat(40),
    ]) {
      expect(isSecretLikeVarValue(normal), normal).toBe(false)
    }
  })
})
