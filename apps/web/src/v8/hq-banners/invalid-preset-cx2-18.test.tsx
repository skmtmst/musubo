// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ presets: vi.fn(), stats: vi.fn(), listImages: vi.fn(), listProjects: vi.fn(), listAccounts: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, hqBanners: { ...actual.api.hqBanners, presets: fixture.presets, stats: fixture.stats,
    projects: { ...actual.api.hqBanners.projects, list: fixture.listProjects }, images: { ...actual.api.hqBanners.images, list: fixture.listImages } },
    lineAccounts: { ...actual.api.lineAccounts, list: fixture.listAccounts } } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams('tab=library') }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useTenantWideAccess: () => true, useStaffRole: () => 'owner' }))
import HqBannersList from './list'

const image = (generation: unknown) => ({
  id: 'img1', projectId: 'p1', generationId: 'g1', sequence: 1, source: 'generated', isFavorite: false,
  createdAt: '2026-09-30T01:00:00Z', deliveredAccountIds: [], generation,
  media: { id: 'm1', filename: 'sample.png', mimeType: 'image/png', sizeBytes: 100, width: 1040, height: 1040, url: 'https://example.invalid/sample.png' },
})
beforeEach(() => {
  fixture.stats.mockResolvedValue({ success: true, data: { projects: { active: 1, archived: 0 }, deliveredImages: 0, deliveredAccounts: 0 } })
  fixture.listProjects.mockResolvedValue({ success: true, data: [{ id: 'p1', name: '秋の案内', archivedAt: null }] })
  fixture.listAccounts.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
const show = (presets: unknown[], generation: unknown) => {
  fixture.presets.mockResolvedValue({ success: true, data: { presets } })
  fixture.listImages.mockResolvedValue({ success: true, data: [image(generation)], nextBefore: null, counts: { all: 1, favorite: 0, delivered: 0, unused: 1 } })
  render(<HqBannersList />)
}

it('用途の識別子が不正でも画像一覧を表示できる', async () => {
  show([{ key: 42, label: '例', aspectRatio: '1:1' }], { presetKey: 42, aspectRatio: '1:1' })
  expect(await screen.findByText('用途を確認できません')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'テキスト・指示で探す' }), { target: { value: '案内' } })
  expect(screen.getByRole('searchbox', { name: 'テキスト・指示で探す' })).toHaveProperty('value', '案内')
})

it('縦横比が不正でも画像一覧を表示できる', async () => {
  show([], { presetKey: 'missing', aspectRatio: { invalid: true } })
  expect(await screen.findByText('用途を確認できません')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'テキスト・指示で探す' }), { target: { value: '案内' } })
  expect(screen.getByRole('searchbox', { name: 'テキスト・指示で探す' })).toHaveProperty('value', '案内')
})
