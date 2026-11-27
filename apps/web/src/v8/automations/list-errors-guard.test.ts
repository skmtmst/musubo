import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { describeAutomationEditFailure } from './list-errors'

describe('describeAutomationEditFailure guards', () => {
  it('returns rate-limit guidance for HTTP 429', () => {
    expect(describeAutomationEditFailure(new ApiError(429, 'Too Many Requests'))).toBe(
      '短い時間に操作が集中しました。少し待ってから、もう一度お試しください。',
    )
  })

  it.each([0, -1, 99, 600])('treats out-of-range ApiError status %s as a network failure', (status) => {
    expect(describeAutomationEditFailure(new ApiError(status, 'invalid'))).toContain('通信状態を確かめて')
  })

  it('preserves existing 401/403/404/409/500 messages', () => {
    expect(describeAutomationEditFailure(new ApiError(401))).toContain('ログイン')
    expect(describeAutomationEditFailure(new ApiError(403))).toContain('権限がありません')
    expect(describeAutomationEditFailure(new ApiError(404))).toContain('見つかりませんでした')
    expect(describeAutomationEditFailure(new ApiError(409))).toContain('重なりました')
    expect(describeAutomationEditFailure(new ApiError(500))).toContain('サーバー側')
  })
})
