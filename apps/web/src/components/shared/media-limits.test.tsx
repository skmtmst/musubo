// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MediaSlot, { mediaLimitLabel } from './media-slot'
afterEach(cleanup)
it('決まり9：形式と上限の文は部品が出し、表示と受け付ける上限を一致させる', async () => {
 const onFile = vi.fn()
 const { container } = render(<MediaSlot title="画像を追加" accept="image/jpeg,image/png" maxBytes={10*1024*1024} onFile={onFile} />)
 expect(screen.getByText('（PNG・JPEG・10MB まで）')).toBeTruthy()
 expect(mediaLimitLabel('image/jpeg,image/png',10*1024*1024)).toBe('PNG・JPEG・10MB まで')
 const file = new File(['x'], 'test.png', {type:'image/png'}); Object.defineProperty(file,'size',{value:10*1024*1024+1})
 fireEvent.change(container.querySelector('input[type=file]')!, {target:{files:[file]}})
 await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
 expect(onFile).not.toHaveBeenCalled()
})
it('共通の選ぶ口を外のボタンから開け、複数ファイルを欠かさず渡す', () => {
 const onFiles=vi.fn(), ref={current:null as HTMLInputElement|null}
 render(<MediaSlot kind="file" title="取り込む" fileInputRef={ref} renderTrigger={(choose)=><button onClick={choose}>選択する</button>} onFiles={onFiles} />)
 const click=vi.spyOn(ref.current!, 'click'); fireEvent.click(screen.getByRole('button',{name:'選択する'})); expect(click).toHaveBeenCalled()
 const files=[new File(['a'],'a.png'),new File(['b'],'b.png')]; fireEvent.change(ref.current!,{target:{files}}); expect(onFiles).toHaveBeenCalledWith(files)
 expect(ref.current?.value).toBe('')
})
