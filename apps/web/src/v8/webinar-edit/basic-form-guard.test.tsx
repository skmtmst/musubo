// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BasicForm, type BasicValues } from './basic-form'

const values: BasicValues = {
  title: '',
  slug: 'INVALID SLUG',
  folderId: '',
  description: '',
  deliveryKind: 'on_demand',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ウェビナー基本設定フォームのエラー関連付けとフォルダ再読込ガード', () => {
  it('名前・URLの誤りを入力欄へaria-describedbyで結び付け、disabled時はフォルダ再読込を止める', () => {
    const onReloadFolders = vi.fn()
    const baseProps = {
      idPrefix: 'wb',
      values,
      onChange: vi.fn(),
      folders: [],
      folderState: 'error' as const,
      onReloadFolders,
      audienceLabel: 'すべての友だち',
      fieldErrors: {
        title: '名前を入力してください',
        slug: '半角英小文字・数字・ハイフンで入力してください',
      },
    }

    const view = render(<BasicForm {...baseProps} disabled />)

    const titleInput = screen.getByRole('textbox', { name: /名前/ })
    const slugInput = screen.getByRole('textbox', { name: /公開ページの URL/ })
    const titleError = screen.getByText('名前を入力してください')
    const slugError = screen.getByText('半角英小文字・数字・ハイフンで入力してください')

    expect(titleError.id).toBe('wb-title-error')
    expect(titleInput.getAttribute('aria-describedby')).toBe('wb-title-error')
    expect(slugError.id).toBe('wb-slug-error')
    expect(slugInput.getAttribute('aria-describedby')).toBe('wb-slug-error')

    const retryButton = screen.getByRole('button', { name: 'もう一度読み込む' }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(true)
    fireEvent.click(retryButton)
    expect(onReloadFolders).not.toHaveBeenCalled()

    view.rerender(<BasicForm {...baseProps} disabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(onReloadFolders).toHaveBeenCalledTimes(1)
  })
})
