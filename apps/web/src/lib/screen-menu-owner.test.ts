import { describe, expect, it } from 'vitest'
import { HQ_MENU_SECTIONS, MENU_SECTIONS, SCREEN_MENU_OWNER, menuOwnerForScreen } from './menu'

/**
 * #984 LAY-15: 画面 → 左メニューの所属。
 *
 * UID移行は URL 上 /accounts 配下だが、中身は友だちの主タブの1枚。
 * 「LINEアカウント」ではなく「友だち」が選ばれることを守る。
 */
describe('画面→メニュー所属の正本（#984 LAY-15）', () => {
  it('UID移行は「友だち」の画面として選ばれる', () => {
    expect(SCREEN_MENU_OWNER['/accounts?tab=migration']).toBe('friends')
    expect(menuOwnerForScreen('/accounts', '?tab=migration')).toEqual(['friends'])
  })

  it('クエリの並びや追加パラメータに左右されない', () => {
    // 共有URLや遷移元の情報がクエリへ乗っても同じ画面として扱う。
    expect(menuOwnerForScreen('/accounts', '?from=sidebar&tab=migration')).toEqual(['friends'])
    // 通常の /accounts は宣言の対象外（LINEアカウントが選ばれる）。
    expect(menuOwnerForScreen('/accounts', '')).toBeUndefined()
    expect(menuOwnerForScreen('/accounts', '?tab=general')).toBeUndefined()
    expect(menuOwnerForScreen('/friends', '')).toBeUndefined()
  })

  it('所属先の項目がメニューに実在する', () => {
    // 統括の画面（/accounts/new など）は統括の左メニューの項目に属する。
    const ids = new Set([...MENU_SECTIONS, ...HQ_MENU_SECTIONS].flatMap((section) => section.items.map((item) => item.id)))
    for (const [screen, owner] of Object.entries(SCREEN_MENU_OWNER)) {
      const candidates = typeof owner === 'string' ? [owner] : owner
      for (const id of candidates) {
        expect(ids.has(id), `${screen} の所属先 ${id} がメニューに無い`).toBe(true)
      }
    }
  })

  it('LINEアカウントの登録は統括の「アカウント」が選ばれる', () => {
    expect(menuOwnerForScreen('/accounts/new', '')).toEqual(['hq-stores'])
  })

  it('メニューと別の URL の画面も、属する項目が選ばれ組が開く（Eo56k・YMVFD）', () => {
    expect(menuOwnerForScreen('/affiliates', '?tab=report')).toEqual(['affiliates'])
    expect(menuOwnerForScreen('/restaurant-test/close-tasks', '')).toEqual(['restaurant-inventory'])
    expect(MENU_SECTIONS.flatMap((section) => section.items).some((item) => ['restaurant-dashboard', 'restaurant-organization', 'restaurant-approvals'].includes(item.id))).toBe(false)
    expect(menuOwnerForScreen('/booking/staff', '')).toEqual(['booking-menus'])
  })


})
