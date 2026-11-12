'use client'

/*
 * ★V8 統合ユーザーの詳細（Pencil 、採用版の流れは `sdbsQ` 板3）。
 *
 * 管理画面（w8W4Eh）と同じ `useMergedPerson` を使う。違いは見せ方——
 * 一覧へは上の帯のパンくず（統合ユーザー）で戻り（板の頭の戻るは 2026-10-08 に無くした）、左に「配信に使う」の切替・結び付き・
 * 履歴、右に「使っている値」と「使う値を直す」を置く。
 * 「配信に使う」は行ごとのスイッチで即保存（expectedRevision つき）。
 * 見るだけの担当者（staff）は変更口を隠さず押せない形にする。
 */
import { PencilLine, Unlink } from 'lucide-react'
import Button from '@/components/shared/button'
import { RowNameLink, TableStateRow } from '@/components/shared/table'
import { deliveryPriorityDetails, linkedFriendDetails, personDetails, profileValueDetails } from './merged-person-metadata'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useAccount } from '@/contexts/account-context'
import { RequiredBadge } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { formatDateTime } from '@/lib/format'
import MergedDeliveryDialog from './merged-delivery-dialog'
import { comparisonSourceLabels } from '@/components/shared/differences-filter'
import MergedProfileDialog from './merged-profile-dialog'
import { useMergedPerson } from './use-merged-person'
import styles from '@/app/friends/friends-v8.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function MergedPersonDetailViewV8({
  personId,
  onClose,
}: {
  personId: string
  onClose: () => void
}) {
  const staffRole = useStaffRole()
  const canManage = canManageRole(staffRole)
  const { selectedAccountId } = useAccount()
  const m = useMergedPerson(personId, selectedAccountId, canManage)

  if (m.phase === 'loading') return <ListState kind="loading" />
  if (m.phase === 'forbidden') {
    return (
      <ListState
        kind="forbidden"
        title={m.failure?.title}
        description={m.failure?.description}
        action={<Button type="button" onClick={onClose}>一覧へ戻る</Button>}
      />
    )
  }
  if (m.phase === 'error' || !m.person) {
    return (
      <ListState
        kind="error"
        title={m.failure?.title}
        description={m.failure?.description}
        onRetry={m.reload}
      />
    )
  }

  const person = m.person
  /*
   * 「配信に使う」は友だち（アカウント）ごとのスイッチ。目的ごとの行を
   * まとめて見て、すべて使うなら ON。一部だけ ON のときはそのまま出す
   * （押すと全部 ON/OFF にそろう）。
   */
  const deliveryRows = person.linkedFriends.map((friend) => {
    const rows = person.deliveryPriorities.filter((p) => p.friendId === friend.friendId)
    return {
      friend,
      active: rows.length > 0 && rows.every((row) => row.isActive),
    }
  })
  const earliestLink = person.linkedFriends.reduce<string | null>(
    (min, f) => (min === null || f.linkedAt < min ? f.linkedAt : min),
    null,
  )

  return (
    <div className={styles.board} data-design-node="Hn9eE">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.headTitle} title={personDetails(person)}>{person.primaryDisplayName}</h2>
          <p className={styles.headDescription}>
            統合ユーザー・結び付いた友だち {person.linkedFriends.length}
            {earliestLink ? `・${shortDate(earliestLink)} に結び付けた` : ''}
          </p>
        </div>
      </div>

      {/* 版競合や保存失敗は面の上に残す（窓を閉じても消えない）。 */}
      {m.saveError ? (
        <Notice tone="danger" className={styles.errorBandNoticePlacement}
          action={<Button type="button" onClick={m.reload}>読み直す</Button>}>{m.saveError}{' '}</Notice>
      ) : null}

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>同じ人に重なって届かないようにする</h3>
            <p className={styles.sectionDesc} title={deliveryPriorityDetails(person.deliveryPriorities)}>
              どのアカウントから送るかを決めます。全部「使わない」にすると、どこからも送れなくなります。
            </p>
            <div className={styles.tableWrap} style={{ border: 0 }}>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headRow}>
                    <th>アカウント</th>
                    <th>表示名</th>
                    <th>状態</th>
                    <th>配信に使う</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveryRows.map(({ friend, active }) => (
                    <tr key={friend.friendId}>
                      <td style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{friend.lineAccountName}</td>
                      <td><RowNameLink href={`/friends/detail?id=${encodeURIComponent(friend.friendId)}`}>{friend.displayName}</RowNameLink></td>
                      <td>
                        <span className={`${styles.pill} ${friend.isFollowing ? styles.pillStrong : styles.pillWeak}`}>
                          {friend.isFollowing ? '友だち' : 'ブロック・削除'}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={active}
                          aria-label={`${friend.lineAccountName} の配信に使う`}
                          className={`${styles.switch} ${active ? styles.switchOn : ''}`}
                          disabled={!canManage || m.saving}
                          title={!canManage ? '変更できるのはオーナーか管理者です' : undefined}
                          onClick={() => m.setDeliveryActive(friend.friendId, !active)}
                        >
                          <span className={styles.switchKnob} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManage ? (
              <div className={styles.cardFoot}>
                <button
                  type="button"
                  className={styles.linkAction}
                  onClick={() => {
                    m.setSaveError('')
                    m.setEditing(true)
                  }}
                >
                  目的ごとの順位を編集 →
                </button>
              </div>
            ) : null}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>結び付いている友だち</h3>
            <p className={styles.sectionDesc}>解除すると、元の2人に戻ります。履歴は残ります。</p>
            <div className={styles.tableWrap} style={{ border: 0 }}>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headRow}>
                    <th>アカウント</th>
                    <th>表示名</th>
                    <th>結び付けた日</th>
                    <th>{/* 解除 */}</th>
                  </tr>
                </thead>
                <tbody>
                  {person.linkedFriends.length === 0 ? <TableStateRow colSpan={4} kind="empty" title="結び付いている友だちはまだありません。" /> : null}
                  {person.linkedFriends.map((friend) => (
                    <tr key={friend.friendId}>
                      <td style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{friend.lineAccountName}</td>
                      <td><RowNameLink href={`/friends/detail?id=${encodeURIComponent(friend.friendId)}`}>{friend.displayName}</RowNameLink></td>
                      <td title={linkedFriendDetails(friend)}>{shortDate(friend.linkedAt)}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.linkAction}
                          disabled={!canManage || m.saving}
                          title={!canManage ? '解除できるのはオーナーか管理者です' : undefined}
                          onClick={() => m.setUnlinkTarget(friend)}
                        >
                          <Unlink size={16} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> 解除する
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>すべてのアカウントを通した履歴</h3>
            {person.history.length === 0 ? (
              <p className={styles.sectionDesc}>まだ履歴はありません。</p>
            ) : (
              <ul className={styles.historyList}>
                {person.history.map((item) => (
                  <li key={item.id} className={styles.historyRow}>
                    <span className={styles.historyWhen}>
                      {formatDateTime(item.occurredAt)} {item.actorName}
                    </span>
                    <span className={styles.historyWhat}>{item.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={styles.detailRail}>
          <Button
            type="button"
            variant="secondary"
            className="w-full justify-center"
            disabled={!canManage}
            title={!canManage ? '変更できるのはオーナーか管理者です' : undefined}
            onClick={m.openProfileEditor}
            data-qa-open="Hn9eE-profile"
          >
            <PencilLine size={16} aria-hidden="true" /> 使う値を直す
          </Button>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>使っている値</h3>
            {person.profileValues.length === 0 ? (
              <p className={styles.sectionDesc}>まだ値はありません。</p>
            ) : (
              <ul className={styles.valueList}>
                {person.profileValues.map((value) => (
                  <li key={value.fieldKey} className={styles.valueRow} title={profileValueDetails(value)}>
                    <span className={styles.valueLabel}>{value.fieldLabel}</span>
                    <span className={styles.valueText}>{value.valuePreview ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <MergedDeliveryDialog
        open={m.editing}
        priorities={person.deliveryPriorities}
        revision={person.revision}
        busy={m.saving}
        error={m.saveError || undefined}
        onCancel={() => m.setEditing(false)}
        onSave={m.save}
      />

      <MergedProfileDialog
        open={m.profileEditing}
        candidates={person.profileCandidates}
        sourceLabels={comparisonSourceLabels(person.linkedFriends.map((friend) => ({ id: friend.friendId, name: friend.displayName, source: friend.lineAccountName })))}
        draft={m.profileDraft}
        revision={person.revision}
        busy={m.profileSaving}
        error={m.saveError || undefined}
        onChange={m.setProfileDraft}
        onCancel={() => m.setProfileEditing(false)}
        onSave={m.saveProfile}
      />

      <Dialog
        open={Boolean(m.unlinkTarget)}
        title="統合を解除"
        description="元の友だちと過去の履歴は消さず、この統合ユーザーとの結び付けだけを解除します。"
        tone="destructive"
        busy={m.unlinking}
        error={m.saveError || undefined}
        onCancel={() => m.setUnlinkTarget(null)}
        designNode="Hn9eE"
        footer={(<DialogActions>
            <Button type="button" onClick={() => m.setUnlinkTarget(null)} disabled={m.unlinking}>キャンセル</Button>
            <Button type="button" variant="danger" onClick={m.unlink} disabled={m.unlinking || !m.unlinkReason.trim()} busy={m.unlinking} busyLabel="解除中…">結び付けを解除</Button>
          </DialogActions>)}
      >
        <OperationTargetSummary accounts={[{ id: m.unlinkTarget?.lineAccountId ?? '', name: m.unlinkTarget?.lineAccountId ? m.unlinkTarget.lineAccountName : '不明' }]} externalTarget={{ label: '友だち', name: m.unlinkTarget?.displayName }} />
        <p style={{ fontSize: 13, color: 'var(--color-ink-secondary)', margin: '0 0 8px' }}>
          解除する友だち：<strong>{m.unlinkTarget?.displayName}</strong>
        </p>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
          <span>解除する理由<RequiredBadge /></span>
          <SaveErrorField names={["unlinkReason","m.unlinkReason","unlink_reason","m.unlink_reason"]}><SharedTextArea
            value={m.unlinkReason}
            onChange={(event) => m.setUnlinkReason(event.target.value)}
            placeholder="確認した根拠を書いてください"
            className={styles.reasonArea}
          /></SaveErrorField>
        </label>
      </Dialog>
    </div>
  )
}
