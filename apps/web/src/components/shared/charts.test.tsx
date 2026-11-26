// @vitest-environment happy-dom
import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {render,screen,cleanup,fireEvent} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {ValueBarChart,LineChart,FunnelChart,chartNumber,chartDate,CHART_COLORS} from './charts'
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('棒の軸・吹き出し・色を共通部品が持ち、不明と0を区別する',()=>{
 const {container}=render(<ValueBarChart label="売上" unit="円" items={[{key:'a',label:'2026-10-09',value:12345},{key:'b',label:'2026-10-10',value:null},{key:'c',label:'2026-10-11',value:0}]}/> )
 expect(screen.getByRole('button',{name:'2026-10-09 12,345円'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'2026-10-10 —'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'2026-10-11 0円'})).toBeTruthy()
 expect(container.querySelector('[style*="background"]')?.getAttribute('style')).toContain(CHART_COLORS.primary)
 expect(chartDate('2026-10-09')).toBe('10/9')
 expect(chartNumber(null,'人')).toBe('—')
})
it('漏斗を選ぶと元の識別子を返す',()=>{
 const select=vi.fn();render(<FunnelChart label="配信" onSelect={select} selectedKey="b" items={[{key:'a',label:'開始',value:10},{key:'b',label:'完了',value:3}]}/> )
 fireEvent.click(screen.getByRole('button',{name:'完了 3人'}));expect(select).toHaveBeenCalledWith('b')
 expect(screen.getByRole('button',{name:'完了 3人'}).getAttribute('aria-pressed')).toBe('true')
})
it('線は欠測をつなげず、実際の時刻と値を読み上げる',()=>{
 const {container}=render(<LineChart label="視聴" points={[{x:0,value:100,label:'0:00'},{x:60,value:null,label:'1:00'},{x:120,value:20,label:'2:00'}]} unit="%"/> )
 expect(container.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
 expect(screen.getByLabelText('2:00 20%')).toBeTruthy()
})

it('狭い軸は間引き、全日付の棒と読み上げを残し、幅が戻れば軸も増える', async () => {
 let width = 320
 let resized: () => void = () => {}
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100, width, height: 100, toJSON: () => ({}) }))
 vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} })
 const items = Array.from({ length: 30 }, (_, i) => ({ key: String(i), label: `2026-09-${String(i + 1).padStart(2, '0')}`, value: i }))
 const { container } = render(<ValueBarChart label="日別" items={items} />)
 expect(screen.getAllByRole('button')).toHaveLength(30)
 expect(screen.getByRole('button', { name: '2026-09-01 0' })).toBeTruthy()
 expect(screen.getByRole('button', { name: '2026-09-30 29' })).toBeTruthy()
 const axes = () => container.querySelectorAll('[data-chart-axis]:not([hidden])')
 const narrow = axes().length
 expect(narrow).toBeLessThanOrEqual(8)
 expect(container.querySelector('[data-axis-edge="first"]')?.hasAttribute('hidden')).toBe(false)
 expect(container.querySelector('[data-axis-edge="last"]')?.hasAttribute('hidden')).toBe(false)
 width = 1200
 const { act } = await import('@testing-library/react')
 act(() => resized())
 expect(axes().length).toBeGreaterThan(narrow)
 expect(screen.getAllByRole('button')).toHaveLength(30)
})

it('符号付きは0基準の上下に描き、欠測と観測0を区別する',()=>{
 render(<ValueBarChart signed label="増減" unit="人" items={[{key:'a',label:'10/1',value:-4},{key:'b',label:'10/2',value:8},{key:'c',label:'10/3',value:null},{key:'d',label:'10/4',value:0}]}/>);
 const negative=screen.getByRole('button',{name:'10/1 -4人'}).querySelector('[style]') as HTMLElement;
 const positive=screen.getByRole('button',{name:'10/2 8人'}).querySelector('[style]') as HTMLElement;
 expect(parseFloat(negative.style.height)).toBeGreaterThan(0);expect(parseFloat(negative.style.bottom)).toBeLessThan(parseFloat(positive.style.bottom));
 expect(screen.getByRole('button',{name:'10/3 —'})).toBeTruthy();expect(screen.getByRole('button',{name:'10/4 0人'})).toBeTruthy();
})

it('時間帯の軸は等間隔を守り、最後の棒も読み上げられる', () => {
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, width: 1000, height: 100, toJSON: () => ({}) }))
 const items = Array.from({ length: 24 }, (_, i) => ({ key: String(i), label: `${i}時台`, value: i }))
 const { container } = render(<ValueBarChart label="時間帯" items={items} showLastAxis={false} />)
 const labels = [...container.querySelectorAll('[data-chart-axis]:not([hidden])')].map(el => el.textContent)
 expect(labels).toEqual(Array.from({ length: 12 }, (_, i) => `${i * 2}時台`))
 expect(screen.getByRole('button', { name: '23時台 23' })).toBeTruthy()
})

it('summary棒グラフでも列幅を超える両端ラベルは枠内へ寄せ、短い月名は中央を保つ', async () => {
 let width = 852
 let resized: () => void = () => {}
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  const edge = this.getAttribute('data-axis-edge')
  if (edge === 'first') return { x: 0, y: 0, top: 0, left: 0, right: 35.5, bottom: 16, width: 35.5, height: 16, toJSON: () => ({}) }
  if (edge === 'last') return { x: 0, y: 0, top: 0, left: 0, right: 107.5, bottom: 16, width: 107.5, height: 16, toJSON: () => ({}) }
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100, width, height: 100, toJSON: () => ({}) }
 })
 vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe() {} disconnect() {} })
 const daily = Array.from({ length: 30 }, (_, i) => ({
  key: String(i),
  label: i === 29 ? '10/01（反映待ち）' : `09/${String(i + 2).padStart(2, '0')}`,
  value: 10 + i,
 }))
 const { container, unmount } = render(<ValueBarChart label="日別クリック数の推移" presentation="summary" unit="クリック" items={daily} />)
 expect(container.querySelector('[data-axis-edge="first"]')?.getAttribute('data-axis-clamp')).toBe('first')
 expect(container.querySelector('[data-axis-edge="last"]')?.getAttribute('data-axis-clamp')).toBe('last')
 const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'charts.module.css'), 'utf8')
 expect(css).toMatch(/\.axis\[data-axis-clamp='first'\]\s*\{[^}]*left:\s*0;[^}]*transform:\s*none;/s)
 expect(css).toMatch(/\.axis\[data-axis-clamp='last'\]\s*\{[^}]*left:\s*auto;\s*right:\s*0;[^}]*transform:\s*none;/s)
 unmount()

 // 短い月名（7本・広めの棒）は中央揃えのまま内寄せしない
 width = 520
 vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  const edge = this.getAttribute('data-axis-edge')
  if (edge === 'first') return { x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 16, width: 20, height: 16, toJSON: () => ({}) }
  if (edge === 'last') return { x: 0, y: 0, top: 0, left: 0, right: 26, bottom: 16, width: 26, height: 16, toJSON: () => ({}) }
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100, width, height: 100, toJSON: () => ({}) }
 })
 const months = Array.from({ length: 7 }, (_, i) => ({ key: `${i + 4}月`, label: `${i + 4}月`, value: (i + 1) * 1000 }))
 const shortView = render(<ValueBarChart label="月ごとの売上" presentation="summary" unit="円" items={months} />)
 expect(shortView.container.querySelector('[data-axis-edge="first"]')?.getAttribute('data-axis-clamp')).toBeNull()
 expect(shortView.container.querySelector('[data-axis-edge="last"]')?.getAttribute('data-axis-clamp')).toBeNull()
 // 幅が極端に狭まり列幅をラベルが超えたら動的に内寄せへ切り替わる
 width = 140
 const { act } = await import('@testing-library/react')
 act(() => resized())
 expect(shortView.container.querySelector('[data-axis-edge="last"]')?.getAttribute('data-axis-clamp')).toBe('last')
})
