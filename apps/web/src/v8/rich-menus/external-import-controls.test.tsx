// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalImportWorkspace, type LineMenu } from './external-import'

afterEach(cleanup)

function sampleMenu(overrides: Partial<LineMenu> = {}): LineMenu {
  return {
    richMenuId: 'rm-ext-1',
    name: '外部のメニュー',
    chatBarText: 'メニューを開く',
    size: { width: 2500, height: 1686 },
    areasCount: 1,
    isCurrentDefault: false,
    adminManaged: false,
    adminInfo: null,
    ...overrides,
  }
}

describe('ExternalImportWorkspace の操作ガード', () => {
  it('読み込み中は「LINEから読み直す」を押せない', () => {
    const onReload = vi.fn()
    render(
      <ExternalImportWorkspace
        external={null}
        loading={true}
        error={null}
        onBack={() => {}}
        onReload={onReload}
        onImport={() => {}}
      />,
    )

    const reloadButton = screen.getByRole('button', { name: /LINEから読み直す/ }) as HTMLButtonElement
    expect(reloadButton.disabled).toBe(true)
    fireEvent.click(reloadButton)
    expect(onReload).not.toHaveBeenCalled()
  })

  it('面の動きを読めていない時は取り込みボタンを押せず、理由を1行出す', () => {
    const onImport = vi.fn()
    render(
      <ExternalImportWorkspace
        external={{ currentDefault: null, lineMenus: [sampleMenu({ areas: undefined })] }}
        loading={false}
        error={null}
        onBack={() => {}}
        onReload={() => {}}
        onImport={onImport}
      />,
    )

    const importButton = screen.getByRole('button', { name: 'この内容で取り込む' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('面ごとの動きを読み込めていないため取り込めません')
    fireEvent.click(importButton)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('面の動きを読めている時は取り込みボタンを押せて取り込み処理へ渡す', () => {
    const onImport = vi.fn()
    const menu = sampleMenu({
      areas: [{
        bounds: { x: 0, y: 0, width: 2500, height: 1686 },
        action: {
          type: 'uri',
          label: null,
          url: 'https://example.com',
          text: null,
          displayText: null,
          richMenuAliasId: null,
          supported: true,
          unsupportedReason: null,
        },
      }],
    })
    render(
      <ExternalImportWorkspace
        external={{ currentDefault: null, lineMenus: [menu] }}
        loading={false}
        error={null}
        onBack={() => {}}
        onReload={() => {}}
        onImport={onImport}
      />,
    )

    const importButton = screen.getByRole('button', { name: 'この内容で取り込む' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(importButton)
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport).toHaveBeenCalledWith(menu)
  })
})
