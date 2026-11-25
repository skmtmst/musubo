import { expect, it, vi } from 'vitest'
import type { BannerGenerationInput } from '@/lib/hq-banners'

const transport = vi.hoisted(() => ({ fetchApi: vi.fn(async () => ({ success: true })) }))
vi.mock('../transport/request', () => transport)
import { hqBannersMethods } from './hq-banners'

it('生成開始と再実行のURLに選んだアカウントを渡す', async () => {
  const input = {} as BannerGenerationInput
  await hqBannersMethods.hqBanners.projects.createGeneration('project/1', input, { accountId: 'store/1' })
  expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/banners/projects/project%2F1/generations?account_id=store%2F1', expect.objectContaining({ method: 'POST' }))
  await hqBannersMethods.hqBanners.generations.run('gen/1', { gravity: 'center' }, 'store/1')
  expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/banners/generations/gen%2F1/run?account_id=store%2F1', expect.objectContaining({ method: 'POST' }))
  await hqBannersMethods.hqBanners.generations.run('gen/1')
  expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/banners/generations/gen%2F1/run', expect.anything())
})
