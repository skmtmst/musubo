'use client'

import SampleScreenNotice from '@/components/ui/sample-screen-notice'
import { ListPage } from '@/components/templates/list-page'
import Button from '@/components/shared/button'
import RestaurantShell from '@/v8/restaurant/booking-kit/shell'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'

/*
 * 見出しの閲覧帯の見張り専用（heading-band guard）。list 型と restaurant 型の
 * 頭に帯を出し、帯の左右が頭の内側と一致することを実ビルドで見る。
 * どこからもリンクしない。本番ビルドでは通常の認証ガードを通る。
 * 2つの型は外枠の直接の子に置く（見張りが拾う形）。
 */
export default function HeadingBandGuardPage() {
  return (
    <>
      <SampleScreenNotice what="見出しの閲覧帯の見張り" backHref="/settings" backLabel="設定へ戻る" />
      <ListPage
        boardId="guard-list"
        title="見張りの一覧"
        subtitle="帯の左右を見るための見本です"
        readOnly
        readOnlyNeed="owner"
        actions={<><Button>絞り込み</Button><Button variant="primary" lockedReason={PERMISSION_LOCK_REASON.viewer}>保存する</Button></>}
      >
        <p>見本の本文</p>
      </ListPage>
      <RestaurantShell
        templateHeading
        boundary={false}
        boardId="guard-shell"
        title="見張りの在庫"
        description="帯の左右を見るための見本です"
        readOnly
        readOnlyNeed="manager"
        headAfter={() => <><Button>店舗を選択する</Button><Button variant="primary" lockedReason={PERMISSION_LOCK_REASON.viewer}>保存する</Button></>}
      />
    </>
  )
}
