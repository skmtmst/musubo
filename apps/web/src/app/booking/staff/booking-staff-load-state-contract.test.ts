import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const STAFF = readFileSync(join(HERE, 'page.tsx'), 'utf8')
const SHIFTS = readFileSync(join(HERE, '../../../v8/booking-menus/settings.tsx'), 'utf8')

describe('V8 予約スタッフ・受付時間の一覧状態', () => {
  // 一覧の読込・失敗・再読込とアカウント切替は各描画試験で確かめる。
  for (const [name, source] of [['予約スタッフ', STAFF], ['受付時間', SHIFTS]] as const) {
    it(`${name}の読み込み状態を定義する`, () => {
      expect(source).toContain("type LoadStatus = 'loading' | 'ready' | 'error'")
      expect(source).toContain(name === '受付時間' ? "setSettingsStatus('ready')" : "setLoadStatus('ready')")
      expect(source).toContain(name === '受付時間' ? "setSettingsStatus('error')" : "setLoadStatus('error')")
    })
  }

  it('休業日の保存失敗で内部のエラー文をそのまま出さない', () => {
    expect(SHIFTS).not.toContain("setError(e instanceof Error ? e.message : String(e))")
    expect(SHIFTS).toContain('休業日を保存できませんでした。')
    expect(SHIFTS).toContain('bookingApi.createException(accountId')
  })
})
