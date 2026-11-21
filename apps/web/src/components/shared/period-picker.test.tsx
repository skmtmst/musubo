// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PeriodPicker, { pastPeriod, validPeriod } from './period-picker'
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
afterEach(cleanup)
it('決まり5：3期間と指定期間を同じ部品で選び、日付は日本時間の暦日を含める', () => {
 const onChange = vi.fn(), onRangeChange = vi.fn()
 render(<PeriodPicker days={30} onChange={onChange} onRangeChange={onRangeChange} />)
 for (const name of ['過去7日', '過去30日', '過去90日', '期間を指定']) expect(screen.getByRole('button', { name })).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: '過去7日' })); expect(onChange).toHaveBeenCalledWith(7)
 fireEvent.click(screen.getByRole('button', { name: '期間を指定' })); expect(screen.getByLabelText('期間の始まり')).toBeTruthy()
 expect(pastPeriod(7, new Date('2026-10-08T16:00:00Z'))).toEqual({ from: '2026-10-03', to: '2026-10-09' })
 expect(validPeriod({ from:'2026-10-09', to:'2026-10-08' })).toBe(false)
})
it('口が28日までのときは30日と偽らず、できない期間を出さない', () => {
 render(<PeriodPicker days={28} supportedDays={[7,28,90]} onChange={vi.fn()} />)
 expect(screen.getByRole('button',{name:'過去28日'})).toBeTruthy()
 expect(screen.queryByRole('button',{name:'過去30日'})).toBeNull()
 expect(screen.queryByRole('button',{name:'期間を指定'})).toBeNull()
})

it('長い期間名でも選択値を保ち、指定期間の2日付へ切り替えられる', () => {
 const onChange = vi.fn(), onRangeChange = vi.fn()
 render(<PeriodPicker days={30} choices={[{ days: 7, label: '過去7日間の分析対象' }, { days: 30, label: '過去30日間の分析対象（キャンペーンを含む）' }]} customRange={{ from: '2026-10-14', to: '2026-10-15' }} onChange={onChange} onRangeChange={onRangeChange} />)
 expect(screen.getByRole('button', { name: '期間を指定' }).getAttribute('aria-pressed')).toBe('true')
 expect(screen.getByRole('button', { name: '期間の始まり' }).textContent).toContain('2026年10月14日')
 expect(screen.getByRole('button', { name: '期間の終わり' }).textContent).toContain('2026年10月15日')
 fireEvent.click(screen.getByRole('button', { name: '過去7日間の分析対象' }))
 expect(onChange).toHaveBeenCalledWith(7)
 expect(onRangeChange).not.toHaveBeenCalled()
})

it('選択欄では指定期間を窓で編集し、適用するまで変更しない', () => {
 const onChange = vi.fn(), onRangeChange = vi.fn()
 render(<PeriodPicker display="select" days={30} onChange={onChange} onRangeChange={onRangeChange} />)
 fireEvent.click(screen.getByRole('button', { name: '集計期間' }))
 fireEvent.click(screen.getByRole('menuitem', { name: '期間を指定' }))
 expect(screen.getByRole('dialog', { name: '期間を指定' })).toBeTruthy()
 expect(onRangeChange).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button', { name: '適用する' }))
 expect(onRangeChange).toHaveBeenCalledOnce()
})
