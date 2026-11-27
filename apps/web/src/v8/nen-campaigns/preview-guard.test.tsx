// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ColumnPreviewCard } from './preview'

afterEach(cleanup)

describe('ColumnPreviewCard の安全な見本表示ガード', () => {
  it('安全な http(s) 以外の画像URLや記事URLでは画像・ボタンを出さない', () => {
    const { container } = render(
      <ColumnPreviewCard
        column={{
          title: '冬の水分補給',
          category: '健康ケア',
          excerpt: '{{pet_name}}の体調管理',
          imageUrl: 'javascript:alert(1)',
          articleUrl: 'javascript:alert(2)',
        }}
        buttonLabel="コラムを読む"
      />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('コラムを読む')).toBeNull()
    expect(screen.getByText('冬の水分補給')).toBeTruthy()
    expect(screen.getByText('大切なご家族の体調管理')).toBeTruthy()
  })

  it('記事URLが空またはボタン文言が空白だけのときはボタンを出さない', () => {
    const first = render(
      <ColumnPreviewCard
        column={{
          title: '記事タイトル',
          category: null,
          excerpt: null,
          imageUrl: null,
          articleUrl: '   ',
        }}
        buttonLabel="コラムを読む"
      />,
    )
    expect(screen.queryByText('コラムを読む')).toBeNull()
    first.unmount()

    const second = render(
      <ColumnPreviewCard
        column={{
          title: '記事タイトル',
          category: null,
          excerpt: null,
          imageUrl: null,
          articleUrl: 'https://example.com/article',
        }}
        buttonLabel="   "
      />,
    )
    expect(second.container.querySelector('button')).toBeNull()
    expect(second.container.querySelector('a')).toBeNull()
  })

  it('題名が空白だけのときは仮の題名を出し、有効な https URL ならボタンを出す', () => {
    render(
      <ColumnPreviewCard
        column={{
          title: '   ',
          category: '   ',
          excerpt: '   ',
          imageUrl: 'https://example.com/cover.jpg',
          articleUrl: 'https://example.com/article',
        }}
        buttonLabel="記事を読む"
      />,
    )

    expect(screen.getByText('（題名がまだありません）')).toBeTruthy()
    expect(screen.getByText('記事を読む')).toBeTruthy()
  })
})
