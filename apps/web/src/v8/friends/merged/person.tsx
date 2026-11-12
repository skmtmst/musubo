'use client'
import { useState } from 'react'
import { Pencil, Unlink } from 'lucide-react'
import { formatDateTime, formatDate as polishFormatDate } from '@/lib/format'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame, PageHeading, PageContent } from '@/components/templates/page-frame'
import { DetailColumns } from '@/components/templates/detail-columns'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useAccount } from '@/contexts/account-context'
import ListState from '@/components/shared/list-state'
import Toggle from '@/components/shared/toggle'
import { TextArea } from '@/components/shared/text-field'
import { DataTable, TableHeadRow, Th, Tr, Td, RowNameLink, TableStateRow } from '@/components/shared/table'
import MergedDeliveryDialog from '@/components/merged-person/merged-delivery-dialog'
import { comparisonSourceLabels } from '@/components/shared/differences-filter'
import MergedProfileDialog from '@/components/merged-person/merged-profile-dialog'
import { useMergedPerson } from '@/components/merged-person/use-merged-person'
import { deliveryPriorityDetails, linkedFriendDetails, personDetails, profileValueDetails } from '@/components/merged-person/merged-person-metadata'
import styles from './person.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import TruncatedText from '@/components/shared/truncated-text'

/*
 * ★V8 統合ユーザーの詳細（Pencil ）。/friends?tab=merged&person=<id>（一覧の名前からも開く）。
 *
 * 読み込み・「配信に使う」の保存・解除・使う値の保存は今と同じ口（components/merged-person の useMergedPerson：
 * 版の照合・409 の読み直し）。窓（目的ごとの順位・使う値・解除の理由）も今のものを使う。
 * 見せ方：頭（← 統合ユーザーへ）→ 左に3つの段、右の列に「使う値を直す」と「使っている値」。
 * 変えられない人には、スイッチ・解除・直すのボタンを置かない（状態の文字だけ）。
 */

/** 9/30（日本時間）。 */
function shortDate(iso: string): string {
  return polishFormatDate(iso, { style: 'list-day', fallback: '—' })
}

const FIELD_WORD: Record<string, string> = { メールアドレス: 'メール', 電話番号: '電話' }

export default function MergedPersonV8({ personId, onClose, onDirtyChange }: { personId: string; onClose: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  usePageTitle('統合ユーザーの詳細')
  const staffRole = useStaffRole()
  const canManage = canManageRole(staffRole)
  const { selectedAccountId } = useAccount()
  const m = useMergedPerson(personId, selectedAccountId, canManage)
  const manageLockedReason = usePermissionLockReason(canManage, 'manager')
  const [valuesExpanded, setValuesExpanded] = useState(false)

  const head = (title: string, description: string) => (
    <PageHeading title={title}
        help={<>{description}</>} />
  )

  if (m.phase !== 'ready' || !m.person) {
    return (
      <PageFrame kind="detail" boardId="Hn9eE">
        {head('統合ユーザー', '結び付けて、同じ人として扱っている人です')}
        <div className={styles.state}>
          {m.phase === 'loading' ? <ListState kind="loading" /> : m.phase === 'forbidden' ? (
            <ListState kind="forbidden" title={m.failure?.title} description={m.failure?.description} action={<Button type="button" onClick={onClose}>一覧へ戻る</Button>} />
          ) : (
            <ListState kind="error" title={m.failure?.title} description={m.failure?.description} onRetry={m.reload} />
          )}
        </div>
      </PageFrame>
    )
  }

  const person = m.person
  const deliveryRows = person.linkedFriends.map((friend) => {
    const rows = person.deliveryPriorities.filter((p) => p.friendId === friend.friendId)
    return { friend, active: rows.length > 0 && rows.every((row) => row.isActive) }
  })
  const earliestLink = person.linkedFriends.reduce<string | null>((min, f) => (min === null || f.linkedAt < min ? f.linkedAt : min), null)

  return (
    <PageFrame kind="detail" boardId="Hn9eE">
      {head(person.primaryDisplayName, `統合ユーザー・結び付いた友だち ${person.linkedFriends.length}${earliestLink ? `・${shortDate(earliestLink)} に結び付けた` : ''}`)}

      {!canManage ? <ReadOnlyNotice need="manager" /> : null}
      <PageContent><DetailColumns asideLabel="使っている値" expanded={valuesExpanded} onExpandedChange={setValuesExpanded} aside={
        <div className={styles.rail}>
          <Button type="button" variant="secondary" className={styles.railButton} disabled={!canManage} lockedReason={manageLockedReason} onClick={m.openProfileEditor} data-qa-open="Hn9eE-profile"><Pencil aria-hidden="true" />使う値を編集する</Button>
          <section className={styles.valuesCard} aria-labelledby="mp-values">
            <h3 id="mp-values" className={styles.valuesTitle} title={personDetails(person)}>使っている値</h3>
            <ul className={styles.values}>
              {person.profileValues.length === 0 ? <li className={styles.cardSub}>まだ値はありません。</li> : null}
              <li className={styles.value}>
                <span className={styles.valueLabel}>LINE表示名</span>
                <span className={styles.valueText}>{person.primaryDisplayName}</span>
              </li>
              {person.profileValues.map((value) => (
                  <li key={value.fieldKey} className={styles.value} title={profileValueDetails(value)}>
                    <span className={styles.valueLabel}>{FIELD_WORD[value.fieldLabel] ?? value.fieldLabel}</span>
                    <span className={styles.valueText}>{value.valuePreview ?? emptyValue('unknown')}</span>
                  </li>
              ))}
            </ul>
          </section>
        </div>
      }>
        <div className={styles.main}>
          {m.saveError ? (
            <Notice tone="danger" >{m.saveError}<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => { m.setSaveError(''); m.reload() }}>状態を確認する</Button></Notice>
          ) : null}

          <section className={styles.card} aria-labelledby="mp-delivery">
            <div className={styles.cardHead}>
              <div className={styles.cardTitleRow}>
                <h3 id="mp-delivery" className={styles.cardTitle}>同じ人に重なって届かないようにする</h3>
                <Button type="button" variant="text" size="inline" disabled={!canManage} lockedReason={manageLockedReason} onClick={() => { if (!canManage) return; m.setSaveError(''); m.setEditing(true) }}>目的ごとの順位を編集 →</Button>
              </div>
              <p className={styles.cardSub} title={deliveryPriorityDetails(person.deliveryPriorities)}>どのアカウントから送るかを決めます。全部「使わない」にすると、どこからも送れなくなります</p>
            </div>
            <DataTable grid={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-fr-dup-col-status) var(--tpl-fr-mp-col-date)', compactColumns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-fr-dup-col-status) var(--tpl-fr-mp-col-date)', padding: 'var(--tpl-fr-dup-thead-pad)', headPadding: 'var(--tpl-fr-dup-thead-pad)', gap: 'var(--tpl-fr-stack-gap)', bodyTextSize: 'var(--text-caption)', headTextSize: 'var(--text-caption)' }}>
              <thead>
                <TableHeadRow>
                  <Th>アカウント</Th>
                  <Th>表示名</Th>
                  <Th>状態</Th>
                  <Th>配信に使う</Th>
                </TableHeadRow>
              </thead>
              <tbody>
                {deliveryRows.map(({ friend, active }) => (
                  <Tr key={friend.friendId} data-row-id={friend.friendId}>
                    <Td><TruncatedText value={friend.lineAccountName} /></Td>
                    <Td><RowNameLink href={`/friends/detail?id=${encodeURIComponent(friend.friendId)}`}>{friend.displayName}</RowNameLink></Td>
                    <Td><span className={friend.isFollowing ? `${styles.pill} ${styles.pillOk}` : `${styles.pill} ${styles.pillMuted}`}>{friend.isFollowing ? '友だち' : 'ブロック・削除'}</span></Td>
                    <Td>
                      <SaveErrorField names={["active","deliveryActive","delivery_active"]}><Toggle checked={active} disabled={!canManage || m.saving} lockedReason={manageLockedReason} label={`${friend.lineAccountName} の配信に使う`} onChange={!canManage || m.saving ? undefined : (next) => m.setDeliveryActive(friend.friendId, next)} /></SaveErrorField>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </section>

          <section className={styles.card} aria-labelledby="mp-linked">
            <div className={styles.cardHead}>
              <h3 id="mp-linked" className={styles.cardTitle}>結び付いている友だち</h3>
              <p className={styles.cardSub}>解除すると、元の2人に戻ります。履歴は残ります</p>
            </div>
            <DataTable grid={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-fr-mp-col-date) var(--tpl-fr-mp-col-date)', compactColumns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-fr-mp-col-date) var(--tpl-fr-mp-col-date)', padding: 'var(--tpl-fr-dup-thead-pad)', headPadding: 'var(--tpl-fr-dup-thead-pad)', gap: 'var(--tpl-fr-stack-gap)', bodyTextSize: 'var(--text-caption)', headTextSize: 'var(--text-caption)' }}>
              <thead>
                <TableHeadRow>
                  <Th>アカウント</Th>
                  <Th>表示名</Th>
                  <Th>結び付けた日</Th>
                  <Th><span className="sr-only">解除</span></Th>
                </TableHeadRow>
              </thead>
              <tbody>
                {person.linkedFriends.length === 0 ? <TableStateRow colSpan={4} kind="empty" title="結び付いている友だちはまだありません。" /> : null}
                {person.linkedFriends.map((friend) => (
                  <Tr key={friend.friendId} data-row-id={friend.friendId}>
                    <Td><TruncatedText value={friend.lineAccountName} /></Td>
                    <Td><RowNameLink href={`/friends/detail?id=${encodeURIComponent(friend.friendId)}`}>{friend.displayName}</RowNameLink></Td>
                    <Td title={linkedFriendDetails(friend)}>{shortDate(friend.linkedAt)}</Td>
                    <Td>
                      <Button type="button" variant="text" size="inline" disabled={!canManage || m.saving} lockedReason={manageLockedReason} onClick={() => { if (canManage) m.setUnlinkTarget(friend) }}>
                        <Unlink size={16} aria-hidden="true" />解除する
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </section>

          <section className={styles.card} aria-labelledby="mp-history">
            <h3 id="mp-history" className={styles.cardTitle}>すべてのアカウントを通した履歴</h3>
            {person.history.length === 0 ? (
              <p className={styles.cardSub}>まだ履歴はありません。</p>
            ) : (
              <DataTable density="records" columns="minmax(0, 1fr) minmax(0, 1fr)"><tbody>
                {person.history.map((item) => (
                  <Tr key={item.id}>
                    <Td><TruncatedText value={`${formatDateTime(item.occurredAt)} ${item.actorName}`} /></Td>
                    <Td><TruncatedText value={item.summary} /></Td>
                  </Tr>
                ))}
              </tbody></DataTable>
            )}
          </section>
        </div>

      </DetailColumns></PageContent>

      <MergedDeliveryDialog
        onDirtyChange={onDirtyChange}
        open={m.editing}
        priorities={person.deliveryPriorities}
        revision={person.revision}
        busy={m.saving}
        error={m.saveError || undefined}
        onCancel={() => m.setEditing(false)}
        onSave={m.save}
      />
      <MergedProfileDialog
        onDirtyChange={onDirtyChange}
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
        <p className={styles.small}>{`解除する友だち：${m.unlinkTarget?.displayName ?? ''}`}</p>
        <Field label="解除する理由" required><SaveErrorField names={["unlinkReason","m.unlinkReason","unlink_reason","m.unlink_reason"]}><TextArea value={m.unlinkReason} onChange={(event) => m.setUnlinkReason(event.target.value)} placeholder="確認した根拠を書いてください" /></SaveErrorField></Field>
      </Dialog>
    </PageFrame>
  )
}
