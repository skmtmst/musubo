// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHqRichMenuDraft, type HqMenuDraft } from './use-hq-rich-menu-draft'

const storeMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}))

vi.mock('@/lib/hq-rich-menu-draft-store', () => ({
  readHqRichMenuDraft: storeMocks.read,
  writeHqRichMenuDraft: storeMocks.write,
}))

function makeSnapshot(name: string): HqMenuDraft {
  return {
    version: 1,
    step: 'shape',
    maxStepIndex: 0,
    group: null,
    pages: [],
    activePageId: null,
    selectedAreaId: null,
    name,
    chatBarText: 'メニュー',
    folderId: '',
    size: 'large',
    tabCount: 0,
    templateKey: 'compact-2',
    pendingImages: [],
    tabNames: ['タブ1'],
    audience: 'all',
    hqTagName: '',
    targetingPriority: 1,
    defaultOpen: true,
    selectedIds: [],
    uploadedKeys: [],
    duplicateMode: 'overwrite',
  }
}

function Harness({ scope, initialName = '' }: { scope: string | undefined; initialName?: string }) {
  const [name, setName] = useState(initialName)
  const draft = useHqRichMenuDraft(scope, makeSnapshot(name), (restored) => setName(restored.name))
  return (
    <div>
      <output data-testid="ready">{String(draft.ready)}</output>
      <output data-testid="failed">{String(draft.failed)}</output>
      <output data-testid="name">{name}</output>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  storeMocks.read.mockResolvedValue(undefined)
  storeMocks.write.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('useHqRichMenuDraft のスコープ切替と失敗の隔離', () => {
  it('前のスコープの保存失敗が遅れて返っても、新しいスコープを failed にしない', async () => {
    let rejectWriteA!: (err: unknown) => void
    storeMocks.write.mockImplementation((scope: string) => {
      if (scope === 'scope-a') return new Promise((_, reject) => { rejectWriteA = reject })
      return Promise.resolve(undefined)
    })

    const view = render(<Harness scope="scope-a" initialName="案A" />)
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    await waitFor(() => expect(storeMocks.write).toHaveBeenCalledWith('scope-a', expect.objectContaining({ name: '案A' })))

    view.rerender(<Harness scope="scope-b" initialName="案A" />)
    await waitFor(() => expect(storeMocks.read).toHaveBeenCalledWith('scope-b'))
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))

    rejectWriteA(new Error('quota exceeded'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.getByTestId('failed').textContent).toBe('false')
  })

  it('scope が一度 undefined を挟んで戻ったとき、復元前に空の下書きで上書きしない', async () => {
    let resolveReadSecond!: (value: unknown) => void
    storeMocks.read
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReadSecond = resolve }))

    const view = render(<Harness scope="scope-a" initialName="" />)
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    storeMocks.write.mockClear()

    view.rerender(<Harness scope={undefined} initialName="" />)
    view.rerender(<Harness scope="scope-a" initialName="" />)

    // 読み込み中は ready=false で、空の下書きを書き込まない
    expect(screen.getByTestId('ready').textContent).toBe('false')
    expect(storeMocks.write).not.toHaveBeenCalled()

    resolveReadSecond(makeSnapshot('保存済みの下書き'))
    await waitFor(() => {
      expect(screen.getByTestId('ready').textContent).toBe('true')
      expect(screen.getByTestId('name').textContent).toBe('保存済みの下書き')
    })
  })
})
