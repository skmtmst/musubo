// @vitest-environment happy-dom
/* ：報酬の決まりの新しい版。保存で落ちた欄は、その欄が赤くなり真下に理由が出て、1つ目の欄へ移る。 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const create = vi.hoisted(() => vi.fn())
const versions = vi.hoisted(() => ({ rows: [] as import('@/lib/api').PhotoRewardPolicyVersion[] }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      nenMembers: {
        ...actual.api.nenMembers,
        photoRewardPolicyVersions: async () => ({ success: true, data: versions.rows }),
        createPhotoRewardPolicyVersion: create,
      },
    },
  }
})

import PhotoPolicyHistoryV8 from './policy-history'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { document.documentElement.setAttribute('data-theme', 'v8'); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); create.mockReset(); versions.rows = [] })
afterEach(() => { act(() => root.unmount()); host.remove(); document.documentElement.removeAttribute('data-theme') })

it('新しい版を作る間は履歴の窓を隠し、保存せず閉じると履歴へ戻る', async () => {
  const onClose = vi.fn()
  await act(async () => { root.render(<PhotoPolicyHistoryV8 open canEdit onClose={onClose} onChanged={() => {}} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しい版を作る' })) })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '版の履歴（報酬の決まり）' })).toBeNull())
  const drawer = screen.getByRole('dialog', { name: '新しい版を作る' })
  expect(drawer.getAttribute('data-height-mode')).toBe('viewport')
  expect(screen.getByRole('button', { name: '版を保存する' }).closest('footer')?.parentElement).toBe(drawer)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true })) })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新しい版を作る' })).toBeNull())
  expect(screen.getByRole('dialog', { name: '版の履歴（報酬の決まり）' })).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('採用したらのマイルが空なら口を呼ばず、その欄が赤くなり理由が出て、そこへ移る', async () => {
  await act(async () => { root.render(<PhotoPolicyHistoryV8 open canEdit onClose={() => {}} onChanged={() => {}} />) })
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しい版を作る' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '版を保存する' })) })
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
  expect(create).not.toHaveBeenCalled()
  const points = document.getElementById('photo-policy-points') as HTMLInputElement
  expect(points.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById('photo-policy-points-error')?.textContent).toBe('採用したら付けるマイルを1〜100000で入力してください。')
  expect(document.getElementById('photo-policy-publication-error')).toBeNull()
  expect(document.activeElement).toBe(points)
})


it('予約版のメニューから今の版と比較し、確定せずに書き換えない', async () => {
  const base = { policyKey: 'photo', summary: '', effectiveFrom: null, createdBy: '担当者', createdAt: '2026-10-01T00:00:00Z' }
  versions.rows = [{ ...base, versionNumber: 1, points: 100, status: 'in_use' }, { ...base, versionNumber: 2, points: 200, status: 'reserved', effectiveFrom: '2026-10-20T00:00:00Z' }]
  await act(async () => { root.render(<PhotoPolicyHistoryV8 open canEdit onClose={() => {}} onChanged={() => {}} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '予約中の第2版の操作' })) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '比べる' })) })
  expect(screen.getByRole('heading', { name: 'いま使っている版と第2版を比べる' })).toBeTruthy()
  expect(create).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'この版に戻す' })).toBeNull()
  expect(screen.getByRole('button', { name: '新しい版を作る' })).toBeTruthy()
})

it('日時を入れた版は予約の操作となり、説明は引き出しの頭で読める', async () => {
  await act(async () => { root.render(<PhotoPolicyHistoryV8 open canEdit onClose={() => {}} onChanged={() => {}} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しい版を作る' })) })
  const drawer = screen.getByRole('dialog', { name: '新しい版を作る' })
  expect(drawer.querySelector('header')?.textContent).toContain('保存しても、使い始めの日時までは今の版のままです。')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '使い始め（日本時間・空ならすぐ）' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '今日', exact: true })) })
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: '日時を選ぶ' })).getByRole('button', { name: '確定' })) })
  await waitFor(() => expect(screen.getByRole('button', { name: '版を予約する' })).toBeTruthy())
  expect(create).not.toHaveBeenCalled()
})
