// @vitest-environment happy-dom
/**
 * 公開用の参照（F2）の編集とプレビュー。
 * 画像ブロックへの固定版の対応付け、本文への共通情報の対応付け、外す操作、壊れた形の警告を見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout, type FormLayout } from '@line-crm/shared'

vi.mock('@/components/shared/media-picker-dialog', () => ({
  default: ({ onSelect }: { onSelect: (item: { id: string; filename: string }) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'media-1', filename: '店内.jpg' })}>見本画像を選ぶ</button>
  ),
}))

const versions = vi.hoisted(() => vi.fn())
const commonVars = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      media: { ...actual.api.media, deleteImpact: versions },
      commonVars: { ...actual.api.commonVars, list: commonVars },
    },
  }
})

import ReferencesPanel from './references-panel'

;(globalThis as unknown as { IS_REACT_ENVIRONMENT: boolean }).IS_REACT_ENVIRONMENT = true

const layout: FormLayout = {
  ...emptyLayout(),
  sections: [{
    id: 's1',
    name: '案内',
    blocks: [
      { id: 'img-1', kind: 'image', mediaUrl: 'https://example.com/a.jpg' },
      { id: 'txt-1', kind: 'text', text: '営業時間の案内' },
    ],
  }],
}

let root: Root | null = null
let container: HTMLDivElement | null = null
async function renderPanel(props?: { readOnly?: boolean; references?: { blockId: string; kind: 'image' | 'store_information'; mediaId?: string; versionNo?: number; alt?: string; fields?: Record<string, { varKey: string }> }[] }) {
  const onChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ReferencesPanel accountId="acc-1" layout={layout} references={(props?.references ?? []) as never} states={null} onChangeReferences={onChange} readOnly={props?.readOnly} />)
  })
  return { onChange }
}
beforeEach(() => {
  versions.mockResolvedValue({ success: true, data: { versions: [{ versionNo: 1, isCurrent: false }, { versionNo: 2, isCurrent: true }] } })
  commonVars.mockResolvedValue({ success: true, data: [{ id: 'cv-1', varKey: 'phone', name: '電話番号' }] })
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('references-panel', () => {
  it('未設定のブロックに固定版を選ぶと参照が足される', async () => {
    const { onChange } = await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '固定版を選ぶ' }))
    fireEvent.click(screen.getByRole('button', { name: '見本画像を選ぶ' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '固定する版' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '固定する版' }))
    fireEvent.click(within(screen.getByRole('option', { name: '第2版（最新）' })).getByRole('button'))
    fireEvent.change(screen.getByRole('textbox', { name: '代替テキスト' }), { target: { value: '店内の写真' } })
    fireEvent.click(screen.getByRole('button', { name: 'この版で固定する' }))
    expect(onChange).toHaveBeenCalledWith([{ blockId: 'img-1', kind: 'image', mediaId: 'media-1', versionNo: 2, alt: '店内の写真' }])
  })

  it('本文に共通情報を選ぶと参照が足される', async () => {
    const { onChange } = await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '共通情報を選ぶ' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '店名' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '店名' }))
    fireEvent.click(within(screen.getByRole('option', { name: '電話番号（phone）' })).getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で対応付ける' }))
    expect(onChange).toHaveBeenCalledWith([{ blockId: 'txt-1', kind: 'store_information', fields: { displayName: { varKey: 'phone' } } }])
  })

  it('付いている参照は外せる', async () => {
    const { onChange } = await renderPanel({ references: [{ blockId: 'img-1', kind: 'image', mediaId: 'media-1', versionNo: 1, alt: '店内' }] })
    fireEvent.click(screen.getByRole('button', { name: '外す' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('壊れた参照は保存前に警告が出る', async () => {
    await renderPanel({ references: [{ blockId: 'img-1', kind: 'image' }] as never })
    expect(screen.getByText('参照の形が正しくありません。保存する前に対応付けを直してください。')).toBeTruthy()
  })

  it('閲覧のみの人には変える操作を出さない', async () => {
    await renderPanel({ readOnly: true })
    expect(screen.queryByRole('button', { name: '固定版を選ぶ' })).toBeNull()
    expect(screen.queryByRole('button', { name: '共通情報を選ぶ' })).toBeNull()
  })

  it('公開中の状態は行に札で出す', async () => {
    const states = new Map([['img-1', { blockId: 'img-1', kind: 'image', state: 'ready', content: { url: 'https://example.com/a.jpg', alt: '店', width: 100, height: 100, mimeType: 'image/jpeg', versionId: 'v1' } }]])
    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)
    await act(async () => {
      root.render(<ReferencesPanel accountId="acc-1" layout={layout} references={[{ blockId: 'img-1', kind: 'image', mediaId: 'media-1', versionNo: 1, alt: '店' }]} states={states as never} onChangeReferences={() => {}} />)
    })
    expect(screen.getByText('画像の固定版：第1版に固定')).toBeTruthy()
    expect(screen.getByText('使える')).toBeTruthy()
    await act(async () => { root.unmount() })
    div.remove()
  })
})
