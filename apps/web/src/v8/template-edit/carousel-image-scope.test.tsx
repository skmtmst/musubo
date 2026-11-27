// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CarouselImage from './carousel-image'

afterEach(cleanup)

function sampleFile(name = 'card-a.png') {
  return new File(['image'], name, { type: 'image/png' })
}

describe('CarouselImage のカード・アカウント切替分離', () => {
  it('前のカードで失敗したエラー・ファイル名・再試行ボタンを、別のカードへ切り替えた後に残さない', async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error('通信エラー'))
    const view = render(
      <CarouselImage
        url=""
        disabled={false}
        scope="acc-1:card-1"
        upload={upload}
        onUploaded={() => {}}
        onBusyChange={() => {}}
        onUrl={() => {}}
      />,
    )

    fireEvent.change(screen.getByLabelText('画像を追加（ファイル）'), {
      target: { files: [sampleFile('card-1.png')] },
    })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('card-1.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'もう一度受け取る' })).toBeTruthy()

    view.rerender(
      <CarouselImage
        url=""
        disabled={false}
        scope="acc-1:card-2"
        upload={upload}
        onUploaded={() => {}}
        onBusyChange={() => {}}
        onUrl={() => {}}
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('card-1.png')).toBeNull()
    expect(screen.queryByRole('button', { name: 'もう一度受け取る' })).toBeNull()
  })

  it('カードを切り替えたあとに前のカードの送信失敗が遅れて返っても、切替先へエラーを出さない', async () => {
    let rejectFirst!: (reason?: unknown) => void
    const upload = vi.fn().mockReturnValueOnce(
      new Promise<string>((_, reject) => { rejectFirst = reject }),
    )

    const view = render(
      <CarouselImage
        url=""
        disabled={false}
        scope="acc-1:card-1"
        upload={upload}
        onUploaded={() => {}}
        onBusyChange={() => {}}
        onUrl={() => {}}
      />,
    )

    fireEvent.change(screen.getByLabelText('画像を追加（ファイル）'), {
      target: { files: [sampleFile('card-1.png')] },
    })

    view.rerender(
      <CarouselImage
        url=""
        disabled={false}
        scope="acc-1:card-2"
        upload={upload}
        onUploaded={() => {}}
        onBusyChange={() => {}}
        onUrl={() => {}}
      />,
    )

    await act(async () => {
      rejectFirst(new Error('遅れて返った失敗'))
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('card-1.png')).toBeNull()
  })
})
