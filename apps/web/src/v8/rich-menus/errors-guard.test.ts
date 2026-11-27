import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { richMenuErrorAll } from './errors'

describe('rich-menus/errors の複製操作エラー分類ガード', () => {
  it('複製時の 403・404・429 を一般的な失敗文に潰さず、次の行動が分かる案内へ変換する', () => {
    expect(richMenuErrorAll(new ApiError(403, 'Forbidden'), 'duplicate'))
      .toBe('このLINEアカウントのリッチメニューを操作する権限がありません。')
    expect(richMenuErrorAll(new ApiError(404, 'Not Found'), 'duplicate'))
      .toBe('対象のリッチメニューが見つかりません。一覧を読み直してください。')
    expect(richMenuErrorAll(new ApiError(429, 'Too Many Requests'), 'duplicate'))
      .toBe('LINEへの操作が混み合っています。少し待ってから、もう一度お試しください。')
  })

  it('複製時の 409・500・内部エラーでも内部詳細を画面へ漏らさない', () => {
    expect(richMenuErrorAll(new ApiError(409, 'Conflict'), 'duplicate'))
      .toBe('複製がほかの操作と重なりました。一覧を読み直してから、もう一度お試しください。')
    const serverMsg = richMenuErrorAll(new ApiError(500, 'D1_ERROR: secret_table'), 'duplicate')
    expect(serverMsg).toBe('リッチメニューを複製できませんでした。もう一度お試しください。')
    expect(serverMsg).not.toContain('D1_ERROR')
  })
})
