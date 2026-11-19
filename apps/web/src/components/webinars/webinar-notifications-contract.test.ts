import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PART = readFileSync(join(HERE, '../../v8/webinar-edit/notifications.tsx'), 'utf8')

/**
 * ウェビナーの通知・リマインド（設計 `Ho8z4` 10-1-D）。
 *
 * **5 つの通知はそれぞれ別の目的を持つ。** まとめて「通知する／しない」に
 * すると、申込のお礼だけ止めたいときに前日・当日まで止まる。
 */
describe('通知の設定', () => {
  it('素の選び口を使わない', () => {
    /* 設計の選び口（`rpot9` / `Gfsb4`）にそろえる。 */
    expect(PART).toContain("import Select from '@/components/shared/select'")
  })
})

// STEP 4の取得/段移動/未保存/親の保存は v8/webinar-edit/edit.test.tsx の実操作へ移した。
