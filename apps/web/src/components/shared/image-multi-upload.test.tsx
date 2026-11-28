// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ImageMultiUpload from './image-multi-upload'
afterEach(cleanup)
it('画像の形式をそろえ、選んだファイルを1枚ずつ親へ渡す', () => {
  const onUpload = vi.fn()
  render(<ImageMultiUpload presentation="library" onUpload={onUpload} />)
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input.accept).toBe('image/png,image/jpeg,image/webp')
  const file = new File(['image'], 'a.png', { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })
  expect(onUpload).toHaveBeenCalledWith(file)
})
it('ライブラリを選ぶ操作でファイル選択を開かず、処理中は操作しない', () => {
  const onPickLibrary = vi.fn(), onUpload = vi.fn(), opened = vi.fn()
  const { rerender } = render(<ImageMultiUpload presentation="reference" onUpload={onUpload} onPickLibrary={onPickLibrary} />)
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  input.addEventListener('click', opened)
  fireEvent.click(screen.getByRole('button', { name: 'ライブラリから選択する' }))
  expect(onPickLibrary).toHaveBeenCalledOnce()
  expect(opened).not.toHaveBeenCalled()
  rerender(<ImageMultiUpload presentation="reference" busy onUpload={onUpload} onPickLibrary={onPickLibrary} />)
  expect(screen.queryByRole('button', { name: 'ライブラリから選択する' })).toBeNull()
  expect(onPickLibrary).toHaveBeenCalledOnce()
})
