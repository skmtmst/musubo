// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import NoPermissionV8 from '@/v8/no-permission/no-permission'

// happy-dom では import.meta.url が file 形にならないため、作業場所からの相対で読む。
const BOARD = readFileSync('src/v8/no-permission/no-permission.tsx', 'utf8')

/*
 * ★V8 権限なし（板 ）の契約。
 * API が 403 を返したときに出す共通の板。V8 のときだけ呼ぶ。
 * 役割の仕組みは作らない——渡された表示名だけを出し、
 * 知らない欄は出さない。無い画面へ送る口は置かない。
 */
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
})

async function renderBoard(props: React.ComponentProps<typeof NoPermissionV8>) {
  await act(async () => {
    root?.render(<NoPermissionV8 {...props} />)
  })
}

describe('V8 権限なし（O5tUeE）の板', () => {
  test('見本どおりの文言と戻る口が出る', async () => {
    await renderBoard({
      featureName: 'シナリオ配信',
      roleLabel: '受付',
      requiredRoleLabel: '運用',
      adminName: 'Demo Person',
      capabilitiesHref: '/staff',
    })
    expect(host?.querySelector('[data-design-node="O5tUeE"]')).not.toBeNull()
    expect(host?.textContent).toContain('シナリオ配信')
    await act(async () => { (host?.querySelector('button[aria-label="シナリオ配信の説明"]') as HTMLButtonElement).click() })
    expect(host?.textContent).toContain('この機能は、あなたの役割では開けません。')
    expect(host?.textContent).toContain('シナリオ配信を開く権限がありません')
    expect(host?.textContent).toContain('いまの役割は「受付」です。')
    expect(host?.textContent).toContain('シナリオ配信は「運用」以上の役割で使えます。')
    expect(host?.textContent).toContain('オーナーか管理者に頼んでください。')
    expect(host?.textContent).toContain('管理者：Demo Person')
    expect(host?.textContent).toContain('役割でできることを見る')
    expect(host?.textContent).toContain('ダッシュボードへ戻る')
  })

  test('知らない欄は出さず、断定しない', async () => {
    await renderBoard({ featureName: '共通情報' })
    expect(host?.textContent).toContain('この画面を開く権限がありません。')
    expect(host?.textContent).not.toContain('いまの役割は「')
    expect(host?.textContent).not.toContain('以上の役割で使えます')
    expect(host?.textContent).not.toContain('管理者：')
    expect(host?.textContent).not.toContain('役割でできることを見る')
    // 戻る口だけは残す。
    expect(host?.textContent).toContain('ダッシュボードへ戻る')
  })

  test('画面の中へ戻るときは押したときの動きになる', async () => {
    const onBack = vi.fn()
    await renderBoard({ featureName: '登録メディア', backLabel: '登録メディア一覧へ戻る', onBack })
    const button = Array.from(host?.querySelectorAll('button') ?? [])
      .find((item) => item.textContent === '登録メディア一覧へ戻る')
    expect(button).toBeTruthy()
    button?.click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

/*
 * 板の印（O5tUeE）と役割の表示は上の描画試験が、共通情報一覧の 403 で
 * この案内が出ることは app/contents/vars/vars-load-failure-react.test.tsx が守る。
 */
describe('V8 権限なし（O5tUeE）の受け口（禁止の見張り）', () => {
  test('「準備中」「取得できません」と言わない', () => {
    expect(BOARD).not.toContain('準備中')
    expect(BOARD).not.toContain('取得できません')
  })
})
