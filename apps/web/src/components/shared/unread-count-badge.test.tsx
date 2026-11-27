// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import UnreadCountBadge from './unread-count-badge'
afterEach(cleanup)
it('未読数を表示し、0は隠し、99以上は99+にする',()=>{
 const {rerender}=render(<UnreadCountBadge count={3}/>)
 expect(screen.getByLabelText('未読 3件').textContent).toBe('3')
 rerender(<UnreadCountBadge count={99}/>);expect(screen.getByLabelText('未読 99件').textContent).toBe('99+')
 rerender(<UnreadCountBadge count={0}/>);expect(screen.queryByLabelText(/未読/)).toBeNull()
})
