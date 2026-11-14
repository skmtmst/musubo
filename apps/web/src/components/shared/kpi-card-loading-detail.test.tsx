// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import KpiCard from './kpi-card'

/** 読み込み中は、数字を含む補足（まだ確かでない「0」など）を出さない。数字の無い補足はそのまま出す。 */
describe('KpiCardの読み込み中の補足', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(() => { act(() => root.unmount()); host.remove() })

  it('読み込み中は補足の数字を出さず、読み込み終わったら渡した補足を出す', () => {
    act(() => root.render(<KpiCard presentation="band" title="保存した分析" value={0} unit="件" detail="クロス分析 0・ファネル 0" loading />))
    const detail = () => host.querySelector('[data-kpi-detail]')?.textContent ?? ''
    expect(detail()).toBe('')
    expect(host.textContent).not.toContain('クロス分析 0')
    act(() => root.render(<KpiCard presentation="band" title="保存した分析" value={0} unit="件" detail="保存した分析の数" loading />))
    expect(detail()).toBe('保存した分析の数')
    act(() => root.render(<KpiCard presentation="band" title="保存した分析" value={3} unit="件" detail="クロス分析 2・ファネル 1" />))
    expect(detail()).toBe('クロス分析 2・ファネル 1')
  })
})
