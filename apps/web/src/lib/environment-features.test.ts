import { afterEach, describe, expect, it, vi } from 'vitest'
import { environmentFeatureUiEnabled, googleBusinessUiEnabled, restaurantTestUiEnabled } from './environment-features'

describe('管理画面の環境限定機能', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('環境変数が未設定なら表示しない', () => {
    vi.stubEnv('NEXT_PUBLIC_RESTAURANT_TEST_ENABLED', '')
    expect(restaurantTestUiEnabled()).toBe(false)
  })

  it.each(['', 'false', '0', 'yes'])(
    '明示的なtrue以外では飲食店テストを表示しない: %s',
    (value) => expect(restaurantTestUiEnabled(value)).toBe(false),
  )

  it.each(['true', 'TRUE', ' true '])('明示的なtrueだけ表示する: %s', (value) => {
    expect(restaurantTestUiEnabled(value)).toBe(true)
  })
})


describe('Google ビジネスの旗', () => {
  afterEach(() => vi.unstubAllEnvs())
  it.each(['', 'false', 'yes'])('明示的なtrue以外では閉じる: %s', value => expect(googleBusinessUiEnabled(value)).toBe(false))
  it('2つの旗を独立して読む', () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_RESTAURANT_TEST_ENABLED', 'false')
    expect(environmentFeatureUiEnabled('/restaurant-test/google')).toBe(true)
    expect(environmentFeatureUiEnabled('/settings/google-hours')).toBe(true)
    expect(environmentFeatureUiEnabled('/restaurant-test/google/photos')).toBe(true)
    expect(environmentFeatureUiEnabled('/restaurant-test/google-other')).toBe(false)
    expect(environmentFeatureUiEnabled('/restaurant-test/delivery')).toBe(false)
    expect(environmentFeatureUiEnabled('/settings/delivery')).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_BUSINESS_ENABLED', 'false')
    vi.stubEnv('NEXT_PUBLIC_RESTAURANT_TEST_ENABLED', 'true')
    expect(environmentFeatureUiEnabled('/restaurant-test/google')).toBe(false)
    expect(environmentFeatureUiEnabled('/settings/google-hours')).toBe(false)
    expect(environmentFeatureUiEnabled('/restaurant-test/delivery')).toBe(true)
  })
})
