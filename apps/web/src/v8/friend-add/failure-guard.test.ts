import { describe, expect, it } from 'vitest'
import { describeFriendAddFailure } from './failure'

describe('describeFriendAddFailure defensive guards', () => {
  it.each([0, -1, 99, 600, 999])('treats out-of-range status %s as a network failure rather than an HTTP status', (status) => {
    const result = describeFriendAddFailure({ status, message: 'Failed to fetch' }, '友だち追加時の配信', 'load')
    expect(result.status).toBeNull()
    expect(result.message).toContain('通信を確認して')
  })

  it('extracts safe Japanese string rejections while still stripping internal error markers', () => {
    expect(describeFriendAddFailure('同じ名前のフォルダがあります', 'フォルダ', 'create')).toEqual({
      status: null,
      message: '同じ名前のフォルダがあります',
    })
    const leaked = describeFriendAddFailure('保存失敗 D1_ERROR SELECT * FROM friends', '設定', 'create')
    expect(leaked.status).toBeNull()
    expect(leaked.message).not.toMatch(/D1_ERROR|SELECT/)
    expect(leaked.message).toContain('通信を確認して')
  })
})
