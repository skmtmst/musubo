// @vitest-environment happy-dom
/*
 * 添付ファイルの行・ファイルを落とす場所（Pencil ★V8「ファイルを落とす欄」）。
 * 行の 3 状態（通常／送り途中／誤りと選び直し）と、落とす場所の 4 状態
 * （ふだん／上に来た／形式違い／取り込み中）、キーボードの「ファイルを選ぶ」を見る。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FileDropzone, { AttachmentRow } from './file-drop'

afterEach(() => cleanup())

function dropFiles(element: Element, files: File[]) {
  fireEvent.drop(element, { dataTransfer: { files, items: [] } })
}

describe('添付ファイルの行（★V8 ファイルを落とす欄）', () => {
  it('名前は 1 行で全文は title、× は「外す」', () => {
    const onRemove = vi.fn()
    render(<AttachmentRow name="商品写真_秋.jpg" meta="JPEG・1.2MB" onRemove={onRemove} />)
    const name = screen.getByText('商品写真_秋.jpg')
    expect(name.getAttribute('title')).toBe('商品写真_秋.jpg')
    expect(screen.getByText('JPEG・1.2MB')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '「商品写真_秋.jpg」を外す' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('送り途中は細い棒（role=progressbar と aria-valuenow）と「送っています 64%」', () => {
    render(<AttachmentRow name="キャンペーン動画.mp4" status="uploading" percent={64} onRemove={() => {}} />)
    const bar = screen.getByRole('progressbar', { name: 'キャンペーン動画.mp4' })
    expect(bar.getAttribute('aria-valuenow')).toBe('64')
    expect(screen.getByText('送っています 64%')).not.toBeNull()
  })

  it('誤りは何をすれば通るかまで書き、操作は「選び直す」になる', () => {
    const onRetry = vi.fn()
    const onRemove = vi.fn()
    render(
      <AttachmentRow
        name="大きすぎる画像.png"
        status="error"
        errorText="10MB を超えています。10MB 以下の画像を選んでください"
        onRemove={onRemove}
        onRetry={onRetry}
      />,
    )
    const note = screen.getByText('10MB を超えています。10MB 以下の画像を選んでください')
    expect(note).not.toBeNull()
    expect(screen.queryByRole('button', { name: '「大きすぎる画像.png」を外す' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '「大きすぎる画像.png」を選び直す' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRemove).not.toHaveBeenCalled()
  })
})

describe('ファイルを落とす場所（★管理画面 NQMnx）', () => {
  it('ふだんは見出し・種類の説明・「ファイルを選ぶ」ボタン', () => {
    render(<FileDropzone title="ここに画像を落とす" hint="JPEG・PNG、10MB まで" onFiles={() => {}} />)
    expect(screen.getByText('ここに画像を落とす')).not.toBeNull()
    expect(screen.getByText('JPEG・PNG、10MB まで')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'ファイルを選択する' })).not.toBeNull()
  })

  it('キーボードの「ファイルを選ぶ」でファイル選択が開く', () => {
    render(<FileDropzone title="ここに画像を落とす" onFiles={() => {}} />)
    const button = screen.getByRole('button', { name: 'ファイルを選択する' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    const clicks: string[] = []
    input?.addEventListener('click', () => clicks.push('opened'))
    fireEvent.click(button)
    expect(clicks).toEqual(['opened'])
  })

  it('落としたファイルは onFiles に渡る', () => {
    const onFiles = vi.fn()
    const { container } = render(<FileDropzone title="ここに画像を落とす" onFiles={onFiles} />)
    const zone = container.firstElementChild as Element
    dropFiles(zone, [new File(['a'], '商品写真_秋.jpg', { type: 'image/jpeg' })])
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['商品写真_秋.jpg'])
  })

  it('形式が違う物を持って来たら先に断る（見た目が変わる）', () => {
    const { container } = render(
      <FileDropzone
        title="ここに画像を落とす"
        accept="image/jpeg,image/png"
        rejectTitle="動画は追加できません"
        rejectHint="JPEG・PNG だけ"
        onFiles={() => {}}
      />,
    )
    const zone = container.firstElementChild as Element
    fireEvent.dragEnter(zone, {
      dataTransfer: {
        items: [{ kind: 'file', type: 'video/mp4', getAsFile: () => new File(['v'], 'movie.mp4', { type: 'video/mp4' }) }],
      },
    })
    expect(zone.getAttribute('data-drag')).toBe('reject')
    expect(screen.getByText('動画は追加できません')).not.toBeNull()
    expect(screen.getByText('JPEG・PNG だけ')).not.toBeNull()
  })

  it('受け付ける物を持って来たら「離すと追加します」', () => {
    const { container } = render(
      <FileDropzone title="ここに画像を落とす" accept="image/jpeg,image/png" onFiles={() => {}} />,
    )
    const zone = container.firstElementChild as Element
    fireEvent.dragEnter(zone, {
      dataTransfer: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['p'], 'a.png', { type: 'image/png' }) }],
      },
    })
    expect(zone.getAttribute('data-drag')).toBe('active')
    expect(screen.getByText('離すと追加します')).not.toBeNull()
  })

  it('見本固定（previewState）があればドラッグ操作で見た目が変わらない', () => {
    const { container } = render(
      <FileDropzone title="ここに画像を落とす" previewState="reject" rejectTitle="動画は追加できません" onFiles={() => {}} />,
    )
    const zone = container.firstElementChild as Element
    expect(zone.getAttribute('data-drag')).toBe('reject')
    fireEvent.dragEnter(zone, {
      dataTransfer: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['p'], 'a.png', { type: 'image/png' }) }],
      },
    })
    expect(zone.getAttribute('data-drag')).toBe('reject')
    expect(screen.getByText('動画は追加できません')).not.toBeNull()
  })

  it('写真の縮小画像は薄い緑の地（data-tone="photo"）', () => {
    const { container } = render(<AttachmentRow name="商品写真_秋.jpg" meta="JPEG・1.2MB" tone="photo" onRemove={() => {}} />)
    const thumb = container.querySelector('[data-tone]')
    expect(thumb?.getAttribute('data-tone')).toBe('photo')
  })

  it('取り込み中は場所を空けたまま進みを出す', () => {
    render(
      <FileDropzone title="ここに画像を落とす" busy busyTitle="3件を取り込んでいます…" busyNote="この画面を閉じても止まりません" onFiles={() => {}} />,
    )
    expect(screen.getByText('3件を取り込んでいます…')).not.toBeNull()
    expect(screen.getByText('この画面を閉じても止まりません')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'ファイルを選択する' })).toBeNull()
  })
})


describe('欄全体から追加するファイル選択', () => {
  it('内側ボタンなしでクリック・Enter・Spaceから同じ選択口を開く', () => {
    const { container } = render(<FileDropzone variant="upload" title="CSVを追加" onFiles={vi.fn()} />)
    const zone = screen.getByRole('button', { name: 'CSVを追加' })
    expect(zone.querySelector('button')).toBeNull()
    expect(zone.tabIndex).toBe(0)
    const input = container.querySelector('input')!
    const opened = vi.fn(); input.addEventListener('click', opened)
    fireEvent.click(zone); fireEvent.keyDown(zone, { key: 'Enter' }); fireEvent.keyDown(zone, { key: ' ' })
    expect(opened).toHaveBeenCalledTimes(3)
  })
  it('取り込み中・無効時はキーとドロップから追加しない', () => {
    const onFiles = vi.fn()
    const { container, rerender } = render(<FileDropzone variant="upload" title="CSVを追加" disabled onFiles={onFiles} />)
    const input = container.querySelector('input')!; const opened = vi.fn(); input.addEventListener('click', opened)
    const zone = screen.getByRole('group', { name: 'CSVを追加' })
    fireEvent.keyDown(zone, { key: 'Enter' }); dropFiles(zone, [new File(['a'], 'a.csv')])
    expect(zone.getAttribute('aria-disabled')).toBe('true')
    rerender(<FileDropzone variant="upload" title="CSVを追加" busy onFiles={onFiles} />)
    fireEvent.click(zone); fireEvent.keyDown(zone, { key: ' ' }); dropFiles(zone, [new File(['a'], 'a.csv')])
    expect(opened).not.toHaveBeenCalled(); expect(onFiles).not.toHaveBeenCalled()
  })
})
