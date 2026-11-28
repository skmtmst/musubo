// @vitest-environment happy-dom
/*
 * ★V8  書く欄の左下のクリップ・書く欄の上の札・会話の中の動画とファイル（「7. 添付」I7Skn）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AttachMenu from './attach-menu'
import AttachmentChip from './attachment-chip'
import AttachmentMessage from './attachment-message'

afterEach(() => cleanup())

describe('左下のクリップ', () => {
  it('押すと「画像・動画」「ファイル」の2つを出し、選んだ口ごとに合う形式だけを選ばせる', () => {
    const onPick = vi.fn()
    const { container } = render(<AttachMenu onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: '添付するものを選択する' }))
    expect(screen.getByRole('menuitem', { name: /画像・動画/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /ファイル/ })).toBeTruthy()
    expect(document.body.textContent).toContain('ダウンロードのリンクとして届く')
    const media = container.querySelector<HTMLInputElement>('input[aria-label="画像・動画を添付（ファイル）"]')!
    const files = container.querySelector<HTMLInputElement>('input[aria-label="ファイルを添付（ファイル）"]')!
    expect(media.accept).toContain('video/mp4')
    expect(media.accept).not.toContain('application/pdf')
    expect(files.accept).toContain('application/pdf')
    expect(files.accept).not.toContain('video/mp4')
    const pdf = new File(['%PDF'], '案内.pdf', { type: 'application/pdf' })
    act(() => { fireEvent.change(files, { target: { files: [pdf] } }) })
    expect(onPick).toHaveBeenCalledWith(pdf, 'file')
  })

  it('会話を選んでいないときは押せない', () => {
    render(<AttachMenu disabled onPick={vi.fn()} />)
    expect((screen.getByRole('button', { name: '添付するものを選択する' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('書く欄の上の札', () => {
  const item = { kind: 'file' as const, name: '案内.pdf', size: 482133 }
  it('準備中・済み・失敗（理由＋もう一度試す）を出し、×で外す', () => {
    const onRemove = vi.fn()
    const onRetry = vi.fn()
    const { rerender } = render(<AttachmentChip item={{ ...item, status: 'uploading' }} onRemove={onRemove} onRetry={onRetry} />)
    expect(document.body.textContent).toContain('準備しています')
    rerender(<AttachmentChip item={{ ...item, status: 'ready' }} onRemove={onRemove} onRetry={onRetry} />)
    expect(document.body.textContent).toContain('471KB・期限30日のリンクで届く')
    rerender(<AttachmentChip item={{ ...item, status: 'failed', error: 'ファイルは10MB以下にしてください' }} onRemove={onRemove} onRetry={onRetry} />)
    expect(screen.getByRole('alert').textContent).toBe('ファイルは10MB以下にしてください')
    fireEvent.click(screen.getByRole('button', { name: /もう一度試す/ }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '「案内.pdf」を外す' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('送っている間は外せない', () => {
    render(<AttachmentChip item={{ ...item, status: 'ready' }} busy onRemove={vi.fn()} onRetry={vi.fn()} />)
    expect((screen.getByRole('button', { name: '「案内.pdf」を外す' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('会話の中の動画・ファイル', () => {
  it('ファイルは名前と期限の札で、押すとリンクを開く', () => {
    render(<AttachmentMessage messageType="file" content={JSON.stringify({ attachmentId: 'f1', filename: '案内.pdf', size: 482133, url: 'https://w.example/f1', expiresAt: '2026-11-07T03:00:00.000Z' })} />)
    const link = screen.getByRole('link', { name: '案内.pdf を開く' }) as HTMLAnchorElement
    expect(link.href).toBe('https://w.example/f1')
    expect(link.textContent).toContain('11月7日（土）まで')
  })

  it('動画は再生できる枠、読めない形は文字だけ', () => {
    const { container, rerender } = render(<AttachmentMessage messageType="video" content={JSON.stringify({ originalContentUrl: 'https://w.example/v' })} />)
    expect(container.querySelector('video')?.getAttribute('src')).toBe('https://w.example/v')
    rerender(<AttachmentMessage messageType="video" content="xx" />)
    expect(container.textContent).toBe('[動画]')
  })
})
