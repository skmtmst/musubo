import { describe, expect, it, vi } from 'vitest'
const get = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { get } } }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: () => ({ progress: undefined, reload: vi.fn() }) }))
import { loadFirstRunSteps } from '@/v8/onboarding/use-first-run'
import { summarizeFirstSteps } from './first-steps'
import { buildStepsFromApi } from '@/v8/settings/getting-started/steps'

/* 初期セット（使う機能）はLINEアカウントの接続時に決まるので、済みなら一覧から外れて5段になる（承認済み Pen v09）。 */
it('同じAPIの段を使い、1人運用にも招待を必須にしない', async () => {
  const steps = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map((key) => ({ key, state: 'done', href: '/', reason: null }))
  get.mockResolvedValue({ success: true, data: { steps } })
  const loaded = await loadFirstRunSteps('acc')
  expect(get).toHaveBeenCalledWith('acc', 'v8')
  expect(loaded).toEqual(buildStepsFromApi(steps as Parameters<typeof buildStepsFromApi>[0]))
  expect(summarizeFirstSteps(loaded)).toMatchObject({ done: 5, total: 5 })
  expect(loaded.some((step) => step.key === 'featureSet')).toBe(false)
})

describe('未取得を未設定にしない', () => {
  it('通信失敗を呼出し側へ返す', async () => {
    get.mockRejectedValue(new Error('offline'))
    await expect(loadFirstRunSteps('acc')).rejects.toThrow('offline')
  })
  it('失敗の応答を空の進捗に置き換えない', async () => {
    get.mockResolvedValue({ success: false, error: 'unavailable' })
    await expect(loadFirstRunSteps('acc')).rejects.toThrow('unavailable')
  })
})
