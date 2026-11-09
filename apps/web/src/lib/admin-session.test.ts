// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { adminSessionHandoffPath, captureTwoFactorChallenge, isOpsTwoFactorReturn, takeTwoFactorNextPath, twoFactorChallengeHandoffPath } from './admin-session'

describe('二段階認証後の戻り先', () => {
  it('query の next=ops を最優先で運営コンソールとして扱う', () => {
    expect(isOpsTwoFactorReturn('?next=ops', '', null)).toBe(true)
  })

  it('従来の hash と sessionStorage の印も後方互換で扱う', () => {
    expect(isOpsTwoFactorReturn('', '#lh_2fa=challenge&lh_next=ops', null)).toBe(true)
    expect(isOpsTwoFactorReturn('', '', 'ops')).toBe(true)
  })

  it('通常のログインは運営コンソールへ送らない', () => {
    expect(isOpsTwoFactorReturn('', '#lh_2fa=challenge', null)).toBe(false)
    expect(isOpsTwoFactorReturn('?next=hq', '', null)).toBe(false)
  })

  it('クロスサイト用sessionを遷移先のfragmentにも引き渡す', () => {
    const url = new URL(adminSessionHandoffPath('/ops', 'opaque+/token=', 'csrf token'), 'https://test.invalid')
    const params = new URLSearchParams(url.hash.slice(1))
    expect(params.get('lh_session')).toBe('opaque+/token=')
    expect(params.get('lh_csrf')).toBe('csrf token')
    expect(params.get('lh_nonce')).toMatch(/^[0-9a-f-]{36}$/)
    expect(adminSessionHandoffPath('/ops', undefined, 'csrf')).toBe('/ops')
  })

  it('電話の画面（next=m）から始めた二段階認証は /m へ戻し、運営・通常の戻り先は変えない', () => {
    sessionStorage.clear()
    const go = (path: string) => {
      const url = new URL(twoFactorChallengeHandoffPath(path, 'challenge-1'), 'https://test.invalid')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      expect(captureTwoFactorChallenge()).toBe('challenge-1')
      return takeTwoFactorNextPath()
    }
    expect(go('/login/two-factor?next=m')).toBe('/m')
    expect(go('/login/two-factor?next=ops')).toBe('/ops')
    expect(go('/login/two-factor/setup?next=musubo-pricing')).toBe('/hq/onboarding/pricing')
    expect(go('/login/two-factor')).toBe('/')
    // 決まった印だけを受ける（任意の住所へは送らない）。
    expect(go('/login/two-factor?next=https://evil.invalid/')).toBe('/')
  })
})
