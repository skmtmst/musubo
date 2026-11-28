// @vitest-environment happy-dom
import { useLayoutEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SearchField from './search-field'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('即時の条件を使う画面は、入力直後の書き出しにも同じ値を渡す', () => {
  const exported = vi.fn()
  function Screen() {
    const [query, setQuery] = useState('')
    return <><SearchField aria-label="回答を探す" value={query} onChange={setQuery} updateMode="immediate" /><button onClick={() => exported(query)}>CSV</button></>
  }
  render(<Screen />)
  fireEvent.change(screen.getByLabelText('回答を探す'), { target: { value: '猫' } })
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
  expect(exported).toHaveBeenCalledWith('猫')
})

it('既定は確定した入力を300ms待ち、一回だけ渡す', () => {
  vi.useFakeTimers()
  const change = vi.fn()
  render(<SearchField aria-label="回答を探す" value="" onChange={change} />)
  fireEvent.change(screen.getByLabelText('回答を探す'), { target: { value: '猫' } })
  vi.advanceTimersByTime(299)
  expect(change).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(change).toHaveBeenCalledExactlyOnceWith('猫')
})

it('初回の値同期より先に入力しても、検索語を消さずに通知する', () => {
  vi.useFakeTimers()
  const change = vi.fn()
  function Screen() {
    useLayoutEffect(() => {
      const input = screen.getByLabelText('回答を探す') as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '猫')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, [])
    return <SearchField aria-label="回答を探す" value="" onChange={change} />
  }
  render(<Screen />)
  expect((screen.getByLabelText('回答を探す') as HTMLInputElement).value).toBe('猫')
  act(() => { vi.advanceTimersByTime(300) })
  expect(change).toHaveBeenCalledExactlyOnceWith('猫')
})

it('入力の待機中に親から別の検索語が来たら、古い入力を通知せず親の値に切り替える', () => {
  vi.useFakeTimers()
  const change = vi.fn()
  const view = render(<SearchField aria-label="回答を探す" value="旧" onChange={change} />)
  fireEvent.change(screen.getByLabelText('回答を探す'), { target: { value: '入力中' } })
  view.rerender(<SearchField aria-label="回答を探す" value="外から指定" onChange={change} />)
  expect((screen.getByLabelText('回答を探す') as HTMLInputElement).value).toBe('外から指定')
  act(() => { vi.advanceTimersByTime(300) })
  expect(change).not.toHaveBeenCalled()
})

it('即時でも変換の途中は渡さず、確定とクリアを保つ', () => {
  const change = vi.fn(), clear = vi.fn()
  render(<SearchField aria-label="回答を探す" value="" onChange={change} onClear={clear} updateMode="immediate" />)
  const field = screen.getByLabelText('回答を探す')
  fireEvent.compositionStart(field)
  fireEvent.change(field, { target: { value: 'ねこ' } })
  expect(change).not.toHaveBeenCalled()
  fireEvent.compositionEnd(field, { data: '猫', target: { value: '猫' } })
  expect(change).toHaveBeenCalledExactlyOnceWith('猫')
  fireEvent.click(screen.getByRole('button', { name: '検索語を消す' }))
  expect(clear).toHaveBeenCalledOnce()
})
