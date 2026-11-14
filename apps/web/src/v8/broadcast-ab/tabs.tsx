'use client'

import type { BroadcastBubble } from '@line-crm/shared'
import HelpTip from '@/components/shared/help-tip'
import SegmentedControl from '@/components/shared/segmented'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { RowMenu } from '@/components/shared/row-actions'
import Card from '@/components/shared/card'
import type { BroadcastAb } from './use-ab'
import styles from './ab.module.css'

/*
 * ③ メッセージの上の A／B のタブ（★V8 QOdsh・要件 G1 §2-1）。
 * B 案が無いときは［B 案を追加］。B 案を消すのは「…」。B 案は A 案の写しから始まる。
 * A/B を使えない配信（全員へ・お知らせ）は呼ぶ側が出さない。
 */
export default function BroadcastAbTabs({ ab, aBubbles, canEdit, locked }: { ab: BroadcastAb; aBubbles: BroadcastBubble[]; canEdit: boolean; locked?: boolean }) {
  return (
    <Card as="section" className={styles.tabsCard} contentPadding="var(--ab-pad) var(--polish-space-section)" aria-label="A/B の案" data-design-node="QOdsh">
      {ab.hasB ? (
        <SegmentedControl aria-label="編集する案" value={ab.tab} onChange={(value) => ab.setTab(value as 'A' | 'B')} options={[{ value: 'A', label: 'A 案' }, { value: 'B', label: 'B 案' }]} />
      ) : <span className={styles.onlyA}>A 案</span>}
      <HelpTip label="A/B の案の説明">本文を 2 つ作り、一部の人に試して、クリック・予約・購入が多かった方を残りの人へ送ります。試し方は ④ 送信設定で決めます。送り手は A・B で同じです。</HelpTip>
      <span className={styles.spacer} />
      {!locked && !ab.hasB ? <PermissionGatedButton allowed={canEdit} size="compact" onClick={() => ab.addB(aBubbles)}>B 案を追加</PermissionGatedButton> : null}
      {canEdit && !locked && ab.hasB ? <RowMenu appearance="box" size="row" label="A/B の案の操作" items={[{ id: 'remove-b', label: 'B 案を消す', tone: 'danger', onSelect: ab.removeB }]} /> : null}
      {locked ? <span className={styles.note}>試し中は本文を直せません</span> : null}
    </Card>
  )
}
