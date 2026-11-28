import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * IDEA-23「この注文の状況」の配線契約。
 *
 * 決めたこと:
 *  - 新しい画面・タブは増やさない。取り込みの記録の行から既存の Drawer で
 *    開く説明パネルだけを足す（親ECの注文台帳の複製はしない）。
 *  - パネルは注文IDとアカウントを束ねて GET /api/ec-commerce/orders/:id
 *    を読み、権限なし・読み込み失敗を別々に出す。
 *  - 「もう一度やる」は一覧と同じ retry を使い、成功済みの処理は重ねない。
 */
const page = readFileSync(join(import.meta.dirname, '../../v8/settings/ec-commerce/screen.tsx'), 'utf8')
const drawer = readFileSync(join(import.meta.dirname, '../../v8/settings/ec-commerce/order-drawer.tsx'), 'utf8')
const api = readApiSource(join(import.meta.dirname, '..', '..', 'lib', 'api.ts'), 'utf8')

describe('IDEA-23 注文の状況パネルの配線', () => {
  it('新しいページやタブを増やさず、行からDrawerを開く', () => {
    expect(page).toContain("import OrderDrawer from './order-drawer'")
    // #670 23: 隣の「中身を見る」と繋がって読めないよう動詞付きにする
    expect(page).toContain("label: '注文の状況を見る'")
    expect(page).not.toContain("label: '注文の状況'")
    expect(page).toContain('setDetailSlot({ accountId, orderId: order.id })')
    // 詳細は既存の共有Drawerで開く（新しい画面骨組みは作らない）
    expect(drawer).toContain("import Drawer from '@/components/shared/drawer'")
  })

  it('詳細APIは注文IDとアカウントを束ねて渡す', () => {
    expect(api).toContain('/api/ec-commerce/orders/${encodeURIComponent(id)}?lineAccountId=')
  })

  it('アカウント切替で別アカウントの注文を残さない', () => {
    expect(page).toContain('detailSlot.accountId === accountId')
    expect(page).toContain('onClose={() => setDetailSlot({ accountId, orderId: null })}')
  })

  // 読込・権限・失敗・古い応答は order-detail-*-rendered-cx6 と order-detail-drawer で確かめる。

  it('再実行は一覧の retry を引き継ぐ', () => {
    expect(page).toContain('onRetryAction={retry}')
  })

  it('生の配送エラーを出さず、台帳の分類を運用の言葉で出す', () => {
    expect(drawer).not.toContain('lastError')
  })
})
