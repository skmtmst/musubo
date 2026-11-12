'use client'


import { useEffect, useRef, useState } from 'react'
import KpiCard from '@/components/shared/kpi-card'
import { Plus } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import HelpTip from '@/components/shared/help-tip'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { DataTable, TableHeadRow, Td, Th, Tr, ActionCell, NameCell, RowNameButton } from '@/components/shared/table'
import { useAccount } from '@/contexts/account-context'
import { formatYen } from '@/lib/format'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { ApiError, fetchApi } from '@/lib/api'
import { restaurantTestApi, type RestaurantMenuItem } from '@/lib/restaurant-test-api'
import { RestaurantShell, Panel, QuietError, StatRow, Status, type RestaurantV8Context } from '@/v8/restaurant/booking-kit/public/shell/index'
import { DialogNote, RowMore, RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import styles from './menu.module.css'
import { formatDateTime as polishFormatDateTime } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'

/*
 * ★V8 メニュー管理（板 ・停止の確認 ・追加と変更 ）。
 *
 * 数5（全メニュー・コース・単品・開始待ち・アレルギー登録）→ メニュー一覧の枠
 * （頭に追加ボタン・「…」の決まりの帯・表）。行末は「…」、アーカイブだけ「再開」。
 * 追加・変更は同じ窓、停止は確認の窓。データの口・送る形は今の画面
 * （app/restaurant-test/v8/menu.tsx）と同じ。動きは BEHAVIOR.md。
 */

export function safeArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function periodLabel(periods: string[]): string {
  return periods.map((period) => (period === 'lunch' ? 'ランチ' : 'ディナー')).join('・') || emptyValue('unknown')
}

function MenuBoard({ ctx }: { ctx: RestaurantV8Context }) {
  const { data, store, busy, mutate, reload } = ctx
  const { selectedAccountId } = useAccount()
  const loadedAccount = useRef({ data, id: selectedAccountId })
  if (loadedAccount.current.data !== data) loadedAccount.current = { data, id: selectedAccountId }
  const dataIsCurrent = loadedAccount.current.id === selectedAccountId
  const role = useStaffRole()
  /* 閲覧のみの人には、追加・変更・停止・再開のボタンを置かない（2026-10-06 オーナー）。 */
  const canEdit = canManageRole(role)
  const rows = store ? data.menuItems.filter((row) => row.store_id === store.id) : data.menuItems
  const legacyPending = rows.some((item) => item.priceChangeStatus === 'pending')
  const scheduledPrices = rows.filter((item) => item.status === 'active' && item.pendingPrice != null && item.priceChangeStatus === 'approved')
  const [stopId, setStopId] = useState('')
  const [deleteId, setDeleteId] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null)
  const [refreshConfirmation, setRefreshConfirmation] = useState<{kind: 'stop' | 'delete'; id: string; scope: string; previous: typeof data} | null>(null)
  const [confirmationError, setConfirmationError] = useState('')
  const [confirmationScope, setConfirmationScope] = useState('')
  const scopeKey = JSON.stringify([selectedAccountId, store?.id ?? null])
  const scopeVersion = useRef({ key: scopeKey, generation: 0 })
  if (scopeVersion.current.key !== scopeKey) scopeVersion.current = { key: scopeKey, generation: scopeVersion.current.generation + 1 }
  const currentScope = JSON.stringify([scopeKey, scopeVersion.current.generation])
  useEffect(() => {
    if (!refreshConfirmation) return
    if (refreshConfirmation.scope !== currentScope) { setRefreshConfirmation(null); return }
    if (refreshConfirmation.previous === data || !dataIsCurrent) return
    const latest = data.menuItems.find(item => item.id === refreshConfirmation.id && item.store_id === store?.id)
    if (latest && Number.isSafeInteger(latest.confirmation_revision) && latest.confirmation_revision > 0) {
      setConfirmationScope(currentScope); setConfirmedRevision(latest.confirmation_revision)
      setConfirmationError('内容が変わりました。最新の内容を確認してください。')
      if (refreshConfirmation.kind === 'stop' && latest.status !== 'archived') setStopId(latest.id)
      if (refreshConfirmation.kind === 'delete') setDeleteId(latest.id)
    }
    setRefreshConfirmation(null)
  }, [refreshConfirmation, data, dataIsCurrent, currentScope, store?.id])
  const stopping = dataIsCurrent && confirmationScope === currentScope ? rows.find((row) => row.id === stopId) : undefined
  const deleting = dataIsCurrent && confirmationScope === currentScope ? rows.find((row) => row.id === deleteId) : undefined
  /* 追加・変更は 1 枚の編集ページ（mauOC）。前の窓は消した。 */
  const router = useRouter()
  const openNew = () => router.push(`/restaurant-test/menu/edit${store ? `?store=${encodeURIComponent(store.id)}` : ''}`)
  const openEdit = (item: RestaurantMenuItem) => router.push(`/restaurant-test/menu/edit?id=${encodeURIComponent(item.id)}`)

  const stop = (item: RestaurantMenuItem) => {
    if (!selectedAccountId || !dataIsCurrent || !confirmedRevision || confirmationScope !== JSON.stringify([scopeVersion.current.key, scopeVersion.current.generation])) return
    void mutate(
      async () => {
        try { await restaurantTestApi.updateMenu(selectedAccountId, item.id, { status: 'archived', expectedVersion: confirmedRevision }) }
        catch (error) { if (error instanceof ApiError && error.code === 'menu_confirmation_conflict') { setStopId(''); setConfirmedRevision(null); setRefreshConfirmation({kind:'stop',id:item.id,scope:currentScope,previous:data}); await reload(); throw new QuietError() }; throw error }
      },
      'メニューを保管しました。予約履歴の参照は残ります。',
    ).then((ok) => { if (ok) setStopId('') })
  }

  /* 参照の有無は削除時にサーバで判定する。 */
  const remove = (item: RestaurantMenuItem) => {
    if (!selectedAccountId || !dataIsCurrent || !confirmedRevision || confirmationScope !== JSON.stringify([scopeVersion.current.key, scopeVersion.current.generation])) return
    void mutate(
      async () => {
        try { await fetchApi(`/api/restaurant-test/menus/${encodeURIComponent(item.id)}?account_id=${encodeURIComponent(selectedAccountId)}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: confirmedRevision }) }) }
        catch (error) { if (error instanceof ApiError && error.code === 'menu_confirmation_conflict') { setDeleteId(''); setConfirmedRevision(null); setRefreshConfirmation({kind:'delete',id:item.id,scope:currentScope,previous:data}); await reload(); throw new QuietError() }; setDeleteError(japaneseDetailOf(error) || '削除できませんでした。'); throw new QuietError() }
      },
      'メニューを削除しました。',
    ).then((ok) => { if (ok) setDeleteId('') })
  }

  const resume = (item: RestaurantMenuItem) => {
    if (!selectedAccountId || !Number.isSafeInteger(item.confirmation_revision) || item.confirmation_revision < 1) return
    void mutate(
      async () => { try { await restaurantTestApi.updateMenu(selectedAccountId, item.id, { status: 'active', expectedVersion: item.confirmation_revision }) } catch (error) { if (error instanceof ApiError && error.code === 'menu_confirmation_conflict') await reload(); throw error } },
      'メニューを再開しました。',
    )
  }

  return (
    <>
      {!canEdit ? <ReadOnlyNotice /> : null}
      <StatRow>
        <KpiCard title="全メニュー" value={rows.length} unit="件" detail="公開・下書き・アーカイブ" detailLayout="single" presentation="band" />
        <KpiCard title="コース" value={rows.filter((item) => item.kind === 'course').length} unit="件" detail="予約時に選択" detailLayout="single" presentation="band" />
        <KpiCard title="単品" value={rows.filter((item) => item.kind !== 'course').length} unit="件" detail="アラカルト" detailLayout="single" presentation="band" />
        <KpiCard title="開始待ち" value={scheduledPrices.length} unit="件" detail="確定済みの新価格" detailLayout="single" presentation="band" />
      </StatRow>
      {/* R11: 帯は4枚まで。5つ目は帯の下の短い1行に残す（行き先の絞り込みは無いため行だけ）。 */}
      <p className={styles.fifthLine}>アレルギー登録 {rows.filter((item) => safeArray(item.allergens_json).length > 0).length} 件 注意品目あり</p>
      <Panel
        title="メニュー一覧"
        description="予約台帳・Google投稿・LINEカードで同じマスターを参照します。価格変更は保存時に確定し、指定した開始日時から新価格になります。"
        aside={canEdit ? (
          <Button variant="primary" onClick={openNew}><Plus size={16} aria-hidden="true" />メニューを作る</Button>
        ) : null}
        flush
        help={<HelpTip label="メニュー一覧の説明">{canEdit ? '「…」から変更・停止・再開・削除ができます。参照中のメニューは削除できません。' : 'メニューの内容と価格を確認できます。'}</HelpTip>}
      >
        {legacyPending ? <Notice tone="warn">以前の価格変更申請が残っています。{canEdit ? <Button onClick={() => router.push('/restaurant-test/approvals')}>以前の申請を確認する</Button> : '管理者に確認を依頼してください。'}</Notice> : null}
        <DataTable columnLayout={{ headHeight: 'var(--tpl-thead-h)', rowHeight: 'var(--tpl-list-row-h)', gap: 'var(--space-16)', padding: '0 var(--tpl-list-inset)', bodyTextSize: 'var(--text-caption)' }}>
          <thead>
            <TableHeadRow data-table-layout="columns">
              <Th grow>メニュー</Th>
              <Th className={styles.colKind}>種類</Th>
              <Th className={styles.colPrice} align="right">価格</Th>
              <Th collapseAt="narrow" className={styles.colPeriod}>提供時間</Th>
              <Th collapseAt="narrow" className={styles.colDuration}>所要時間</Th>
              <Th className={styles.colAllergy}>アレルギー</Th>
              <Th className={styles.colStatus}>状態</Th>
              <Th className={styles.colOps} align="right">操作</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rows.map((item) => {
              const archived = item.status === 'archived'
              const draftItem = item.status === 'draft'
              const pending = item.status === 'active' && item.pendingPrice != null
              const allergens = safeArray(item.allergens_json)
              return (
                <Tr data-row-id={item.id} key={item.id} data-table-layout="columns" onOpen={() => openEdit(item)}>
                  <NameCell grow name={<RowNameButton title={item.name} onClick={() => openEdit(item)}>{item.name}</RowNameButton>} description={pending ? `${item.priceChangeStatus === 'approved' ? '変更後' : '申請価格'} ${formatYen(item.pendingPrice ?? 0)}・${item.pendingEffectiveAt ? polishFormatDateTime(new Date(item.pendingEffectiveAt)) : '日時未定'}` : undefined} />
                  <Td className={styles.colKind}>{item.kind === 'course' ? 'コース' : '単品'}</Td>
                  <Td className={styles.colPrice} align="right">{formatYen(item.price)}</Td>
                  <Td collapseAt="narrow" className={styles.colPeriod}>{periodLabel(safeArray(item.service_periods_json))}</Td>
                  <Td collapseAt="narrow" className={styles.colDuration}>{item.duration_minutes ? `${item.duration_minutes}分` : emptyValue('unknown')}</Td>
                  <Td className={styles.colAllergy}><TruncatedText value={allergens.join('・') || emptyValue('none')} /></Td>
                  <Td className={styles.colStatus}>
                    {pending ? (
                      <span title={`新価格 ${formatYen(item.pendingPrice ?? 0)}${item.pendingEffectiveAt ? `・${polishFormatDateTime(new Date(item.pendingEffectiveAt))}から` : ''}`}>
                        <Status value="pending" label={item.priceChangeStatus === 'approved' ? '開始待ち' : '申請中'} />
                      </span>
                    ) : <Status value={archived ? 'archived' : draftItem ? 'draft' : item.status === 'paused' ? 'paused' : 'active'} label={archived ? '停止中' : undefined} />}
                  </Td>
                  <ActionCell className={styles.colOps}>
                    {canEdit ? (
                      <span className={styles.rowActions}>
                        {archived ? <Button disabled={busy} onClick={() => resume(item)}>再開</Button> : null}
                        <RowMore
                          subject={`メニュー「${item.name}」`}
                          items={[
                            { id: 'edit', label: '変更', onSelect: () => openEdit(item) },
                            ...(archived
                              ? [{ id: 'resume', label: '再開', onSelect: () => resume(item) }]
                              : draftItem ? [] : [{ id: 'stop', label: '停止', onSelect: () => { if (dataIsCurrent) { setConfirmationScope(currentScope); setConfirmedRevision(item.confirmation_revision); setConfirmationError(''); setStopId(item.id) } } }]),
                            { id: 'delete', label: '削除', tone: 'danger' as const, dividerBefore: true, onSelect: () => { if (dataIsCurrent) { setConfirmationScope(currentScope); setConfirmedRevision(item.confirmation_revision); setConfirmationError(''); setDeleteError(''); setDeleteId(item.id) } } },
                          ]}
                        />
                      </span>
                    ) : null}
                  </ActionCell>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      </Panel>
      <RsDialog
        open={Boolean(stopping)}
        title="このメニューを停止しますか？"
        width={480}
        top={300}
        busy={busy}
        designNode="MV5Os"
        onCancel={() => setStopId('')}
        actions={(
          <>
            <Button onClick={() => setStopId('')} disabled={busy}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { if (stopping) stop(stopping) }}>停止する</Button>
          </>
        )}
      >
        <p className={styles.stopName}>{stopping?.name}</p>
        <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: stopping?.store_id ?? '', name: data.stores.find((entry) => entry.id === stopping?.store_id)?.name }} />
        <DialogNote>メニューは保管され、予約履歴の参照は残ります。後で再開できます。</DialogNote>
        {confirmationError ? <Notice tone="warn">{confirmationError}</Notice> : null}
      </RsDialog>
      <RsDialog
        open={Boolean(deleting)}
        title="このメニューを削除しますか？"
        width={480}
        top={300}
        busy={busy}
        onCancel={() => setDeleteId('')}
        actions={(
          <>
            <Button onClick={() => setDeleteId('')} disabled={busy}>キャンセル</Button>
            <Button variant="danger" disabled={busy} onClick={() => { if (deleting) remove(deleting) }}>削除する</Button>
          </>
        )}
      >
        <p className={styles.stopName}>{deleting?.name}</p>
        <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: deleting?.store_id ?? '', name: data.stores.find((entry) => entry.id === deleting?.store_id)?.name }} />
        <DialogNote>予約や設定で使われていないメニューだけ削除できます。元に戻せません。</DialogNote>
        {confirmationError ? <Notice tone="warn">{confirmationError}</Notice> : null}
        {deleteError ? <Notice tone="danger">{deleteError}</Notice> : null}
      </RsDialog>
    </>
  )
}

export default function MenuPage() {
  return (
    <RestaurantShell headingInset="none" boardId="MJoJR" title="メニュー管理" description="コースと単品、価格、アレルギー、提供時間帯を管理します。">
      {(ctx) => <MenuBoard ctx={ctx} />}
    </RestaurantShell>
  )
}
