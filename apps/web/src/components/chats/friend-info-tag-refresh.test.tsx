// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { expect, it, vi } from 'vitest'
import { useFriendInfoEditing } from './use-friend-info-editing'

it('同じタグを再取得しても保存中の表示を消さず、実際に内容が変われば更新する', () => {
  const original = [{ id: 'a', name: '既存', color: '#123456' }]
  const { result, rerender } = renderHook(({ tags }) => {
    const [localTags, setLocalTags] = useState<typeof original | undefined>()
    const targetRef = useRef({ key: 'friend', generation: 1 })
    const memoAreaRef = useRef<HTMLTextAreaElement | null>(null)
    const noop = vi.fn()
    const options = { friend: { tags }, setLocalTags, targetRef, memoAreaRef, setLocalStatus: noop, setLocalOperatorId: noop, setLocalNotes: noop, setFriend: noop, beginChange: () => () => true }
    useFriendInfoEditing(options as unknown as Parameters<typeof useFriendInfoEditing>[0])
    return { localTags, setLocalTags }
  }, { initialProps: { tags: original } })
  act(() => result.current.setLocalTags([...original, { id: 'b', name: '追加', color: '#abcdef' }]))
  rerender({ tags: original.map(tag => ({ ...tag })) })
  expect(result.current.localTags?.map(tag => tag.id)).toEqual(['a', 'b'])
  rerender({ tags: [...original, { id: 'c', name: '他の更新', color: '#000000' }] })
  expect(result.current.localTags).toBeUndefined()
})
