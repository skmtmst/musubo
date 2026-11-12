'use client'
import { formatYen } from '@line-crm/shared';

import { notificationResultUnknown } from './detail-model'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

import { PageHeading } from '@/components/templates/page-frame'


import Link from 'next/link'

import { type BookingNotificationPolicy } from '@/lib/api'

import Button from '@/components/shared/button'
import TextLink from '@/components/shared/text-link'

import TagPill from '@/components/shared/tag-pill'

import Checkbox from '@/components/shared/checkbox'

import HelpTip from '@/components/shared/help-tip'

import ConfirmDialog from '@/components/shared/confirm-dialog'

import DateField from '@/components/shared/date-field'

import Notice from '@/components/shared/notice'

import Select from '@/components/shared/select'

import TargetMissing from '@/components/shared/target-missing'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { isForbiddenOrRateLimited, loadFailureCopy } from '@/components/shared/api-error-message'


import { formatNumber } from '@/lib/format'

import { ACTION_LABELS, STATUS_LABELS, STATUS_BADGE, OPERATION_STATUS_LABELS, POLICY_FIELD_LABELS, notificationOpLine, decideDescription, jpDateTime, jpTime, jpStamp, jstDate, jstHHMM, bookingNumber, approvedText, auditLine } from './detail-model'

import type { BookingDetailModel } from '@/app/booking/bookings'
import { withHonorific } from '@line-crm/shared'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'

export default function BookingDetailScreen({ model }: { model: BookingDetailModel }) {
  const {
    id,
    selectedAccountId,
    loading,
    acting,
    decideTarget,
    setDecideTarget,
    closeDecideTarget,
    error,
    setError,
    loadError,
    bookingMissing,
    detail,
    editing,
    setEditing,
    editMenus,
    editStaff,
    editMenuId,
    setEditMenuId,
    editStaffId,
    setEditStaffId,
    editDate,
    setEditDate,
    editTime,
    setEditTime,
    editSlots,
    editSlotsLoading,
    editPrice,
    setEditPrice,
    editCustomerNote,
    setEditCustomerNote,
    editInternalNote,
    setEditInternalNote,
    editPolicy,
    setEditPolicy,
    editSendNotice,
    setEditSendNotice,
    editReason,
    setEditReason,
    saving,
    retrying,
    auditLoading,
    auditError,
    historyOpen,
    setHistoryOpen,
    canOperate,
    staffResolved,
    load,
    status,
    editable,
    isLineLinked,
    failedCalendarOps,
    failedNotificationOps,
    queuedCalendar,
    notificationOps,
    shownAuditLogs,
    auditRemaining,
    auditTruncated,
    attentionItems,
    loadMoreAudit,
    decide,
    startEdit,
    saveEdit,
    retryCalendar,
    retryNotification,
  } = model

  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="見る予約が指定されていません"
        description="一覧から、見たい予約を選び直してください。"
        backHref="/booking/bookings"
        backLabel="予約一覧へ戻る"
      />
    )
  }

  if (!loading && (bookingMissing || (!error && !detail))) {
    return (
      <TargetMissing
        kind="not-found"
        title="この予約は見つかりません"
        description="取り消されたか、別の記録です。一覧から選び直してください。"
        backHref="/booking/bookings"
        backLabel="予約一覧へ戻る"
      />
    )
  }

  // 権限・混雑は共通の案内にする。手動の読み直しはTargetMissingの契約に従い、
  // 取得し直すまで前の予約内容や変更操作を出さない。
  const detailFailure = loadError ? loadFailureCopy(loadError, '予約') : null
  const useCommonCopy = loadError ? isForbiddenOrRateLimited(loadError) : false
  if (!loading && error && !detail) {
    return (
      <TargetMissing
        kind="error"
        title={useCommonCopy && detailFailure ? detailFailure.title : '予約を読み込めませんでした'}
        description={useCommonCopy && detailFailure ? detailFailure.description : '通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'}
        error={loadError ?? undefined}
        onRetry={() => void load()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4" data-design-node="If9Mh">
      <div><PageHeading title={detail ? `${detail.customer.displayName} ／ ${detail.menuName}` : '予約の詳細'} /></div>
      {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}

      {error && detail && (
        <Notice tone="danger" message={error} onClose={() => setError('')} className="mb-4" />
      )}

      {loading || !detail ? (
        <div className="bg-canvas rounded-card border-hairline text-ink-faint border p-8 text-center text-sm">
          読み込み中…
        </div>
      ) : (
        <div data-design="Body" className="flex flex-col gap-4 xl:flex-row">
          <div data-design="Left" className="min-w-0 flex-1 space-y-4">
            <section data-design="Sum" className="bg-canvas rounded-card border-hairline border p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-ink text-base font-semibold">{detail.menuName}</h2>
                <span
                  className={`rounded-pill px-2 py-0.5 text-xs ${STATUS_BADGE[status] ?? 'bg-canvas-sunken text-ink-secondary'}`}
                >
                  {STATUS_LABELS[status] ?? status}
                </span>
                <span className="text-ink-faint font-mono text-xs">
                  予約番号 {bookingNumber(detail.id)}
                </span>
              </div>
              <Row label="日時">
                {jpDateTime(detail.startsAt)}〜{jpTime(detail.endsAt)}
              </Row>
              <Row label="担当">{detail.staffName}</Row>
              <Row label="料金">
                <span className="tabular-nums">
                  {formatYen(detail.price)}（税込）
                </span>
              </Row>
              <Row label="申込日時">{jpStamp(detail.requestedAt)}</Row>
              <Row label="Googleカレンダー">
                {detail.calendarSync === 'synced' ? '反映済み'
                  : detail.calendarSync === 'failed' ? (
                    <span className="text-danger">
                      反映に失敗しています
                      {canOperate ? (
                        <button
                          type="button"
                          onClick={() => void retryCalendar()}
                          disabled={retrying !== null || queuedCalendar}
                          className="text-action ml-2 underline"
                        >
                          {retrying === 'calendar' ? '再試行中…' : 'もう一度反映する'}
                        </button>
                      ) : null}
                    </span>
                  ) : detail.calendarSync === 'pending' ? '反映処理中' : '未設定'}
              </Row>
            </section>

            {/* ---- 予約した時の内容の写し (T) ---- */}
            {(() => {
              const snapshot = detail.menuSnapshot ?? null
              if (!snapshot) return null
              const bookedMinutes = Math.round(
                (new Date(detail.endsAt).getTime() - new Date(detail.startsAt).getTime()) / 60000,
              )
              // 写しがいまのメニューと同じなら、同じ数字を二度出さない。
              if (
                snapshot.name === detail.menuName
                && snapshot.basePrice === detail.price
                && snapshot.durationMinutes === bookedMinutes
              ) return null
              return (
                <section className="bg-canvas rounded-card border-hairline border p-5">
                  <h2 className="text-ink mb-3 text-sm font-semibold">
                    予約した時の内容
                    <HelpTip label="予約した時の内容の説明">
                      予約した時点のメニューの写しです。あとでメニューを変えても、この予約の内容は変わりません。
                    </HelpTip>
                  </h2>
                  <Row label="メニュー">{snapshot.name}（第{snapshot.version}版の内容）</Row>
                  <Row label="時間">{snapshot.durationMinutes} 分</Row>
                  <Row label="料金">
                    <span className="tabular-nums">
                      {snapshot.priceMode === 'free'
                        ? '無料'
                        : snapshot.priceMode === 'inquiry'
                          ? 'お問い合わせ'
                          : `${formatYen(snapshot.basePrice)}（税込）`}
                    </span>
                  </Row>
                </section>
              )
            })()}

            {/* ---- 予約内容の変更 (N-389) ---- */}
            {editing ? (
              <section className="bg-canvas rounded-card border-hairline border p-5" data-design-node="YXrF6">
                <fieldset disabled={saving} className="contents">
                <h2 className="text-ink mb-3 text-sm font-semibold">予約の内容を変える</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  <EditField label="予約メニュー">
                    <EntitySelect kind="booking_menu" disabled={saving} size="full" aria-label="予約メニュー" value={editMenuId} onChange={(value) => { setEditMenuId(value); setEditTime('') }} options={editMenus.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.name }))} />
                  </EditField>
                  <EditField label="スタッフ">
                    <EntitySelect disabled={saving} size="full" aria-label="スタッフ" value={editStaffId} onChange={(value) => { setEditStaffId(value); setEditTime('') }} options={editStaff.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.display_name }))} />
                  </EditField>
                  <EditField label="日付">
                    <DateField
                      disabled={saving}
                      aria-label="予約の日付"
                      value={editDate}
                      onChange={(v) => { setEditDate(v); setEditTime('') }}
                    />
                  </EditField>
                  <EditField label="時間">
                    <Select size="full" aria-label="時間" value={editTime} onChange={(value) => setEditTime(value)} disabled={saving || editSlotsLoading} options={[ { value: '', label: editSlotsLoading ? '確認中です' : '選択してください' }, ...editSlots.map((slot) => ({ value: slot.start, label: `${slot.start}〜${slot.end}${ slot.date === jstDate(detail.startsAt) && slot.start === jstHHMM(detail.startsAt) ? '（現在）' : '' }`, })), ]} />
                  </EditField>
                  <EditField label="料金（円・税込）">
                    <SharedTextField
                      disabled={saving}
                      type="number"
                      min={0}
                      value={editPrice}
                      onChange={(event) => setEditPrice(event.target.value)}
                      className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
                    />
                  </EditField>
                  <EditField label="変更理由（記録に残ります・任意）">
                    <SharedTextField
                      disabled={saving}
                      type="text"
                      value={editReason}
                      onChange={(event) => setEditReason(event.target.value)}
                      placeholder="例: お客様の都合で時間変更"
                      className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
                    />
                  </EditField>
                </div>
                <div className="mt-3 grid gap-3">
                  <EditField label="お客様からの要望">
                    <SharedTextArea
                      disabled={saving}
                      value={editCustomerNote}
                      onChange={(event) => setEditCustomerNote(event.target.value)}
                      rows={3}
                      className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
                    />
                  </EditField>
                  <EditField label="店内メモ（お客様には見えません）">
                    <SharedTextArea
                      disabled={saving}
                      value={editInternalNote}
                      onChange={(event) => setEditInternalNote(event.target.value)}
                      rows={2}
                      className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
                    />
                  </EditField>
                </div>
                {isLineLinked ? (
                  <div className="border-hairline mt-4 border-t pt-4">
                    <p className="text-ink mb-2 text-xs font-medium">お知らせの送り方（この予約だけの設定）</p>
                    <div className="space-y-2">
                      {(Object.keys(POLICY_FIELD_LABELS) as Array<keyof BookingNotificationPolicy>).map((key) => (
                        <Checkbox disabled={saving} key={key} checked={editPolicy[key]} onCheckedChange={(checked) => setEditPolicy((prev) => ({ ...prev, [key]: checked }))}>{POLICY_FIELD_LABELS[key]}を送る</Checkbox>
                      ))}
                      <Checkbox disabled={saving} checked={editSendNotice} onCheckedChange={setEditSendNotice}>今回の変更をお客様のLINEに知らせる</Checkbox>
                    </div>
                  </div>
                ) : (
                  <p className="text-ink-faint border-hairline mt-4 border-t pt-4 text-xs">
                    LINEと結びついていないため、お知らせは届きません。
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => void saveEdit()}
                    disabled={saving} busy={saving} busyLabel="保存しています">この内容にする
                  </Button>
                  <Button
                    type="button"
                    onClick={() => { setEditing(false); setError('') }}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                </div>
                </fieldset>
              </section>
            ) : (
              <section id="sec-answer" className="bg-canvas rounded-card border-hairline border p-5">
                <h2 className="text-ink mb-3 text-sm font-semibold">申込時にいただいた回答</h2>
                {detail.customerNote ? (
                  <>
                    <p className="text-ink-faint text-xs">気になっていること</p>
                    <p className="text-ink mt-1 text-sm whitespace-pre-wrap">
                      {detail.customerNote}
                    </p>
                  </>
                ) : (
                  <p className="text-ink-faint text-sm">記入はありませんでした。</p>
                )}
                {detail.internalNote ? (
                  <div className="mt-3">
                    <p className="text-ink-faint text-xs">店内メモ</p>
                    <p className="text-ink mt-1 text-sm whitespace-pre-wrap">{detail.internalNote}</p>
                  </div>
                ) : null}
              </section>
            )}

            <section id="sec-customer" className="bg-canvas rounded-card border-hairline border p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-ink text-sm font-semibold">お客さま</h2>
                {detail.customer.friendId ? (
                  <Link
                    href={`/friends/detail?id=${encodeURIComponent(detail.customer.friendId)}`}
                    className="text-action text-xs hover:underline"
                  >
                    友だち詳細を見る
                  </Link>
                ) : null}
              </div>
              <Row label="お名前">
                {detail.customer.displayName ? `${withHonorific(detail.customer.displayName, 'さま', { space: true })}` : '未設定'}
              </Row>
              {isLineLinked ? (
                <Row label="LINEの表示名">{detail.customer.displayName ?? '未設定'}</Row>
              ) : (
                <Row label="LINEとの結びつき">
                  <span className="text-ink-faint">結びついていません（電話でのご予約）</span>
                </Row>
              )}
              <Row label="連絡先">
                {detail.customer.phone ?? '登録なし'}
              </Row>
              {detail.customer.petName ? (
                <Row label="ペットの名前">{detail.customer.petName}</Row>
              ) : null}
              {detail.customer.tags.length > 0 ? (
                <Row label="タグ">
                  <span className="flex flex-wrap gap-1">
                    {detail.customer.tags.map((tag) => (
                      <TagPill key={tag.id} name={tag.name} />
                    ))}
                  </span>
                </Row>
              ) : null}
              {detail.customer.mileageBalance !== null
              && detail.customer.mileageBalance !== undefined ? (
                <Row label="マイル">
                  <span className="tabular-nums">{formatNumber(detail.customer.mileageBalance)}</span>
                </Row>
              ) : null}
              {detail.previousHandover?.trim() ? (
                <Row label="前回の申し送り">
                  <span className="whitespace-pre-wrap">{detail.previousHandover}</span>
                  {detail.previousHandoverBooking ? (
                    <span className="text-ink-faint mt-1 block text-xs">
                      {jpStamp(detail.previousHandoverBooking.startsAt)}の来店
                      （{STATUS_LABELS[detail.previousHandoverBooking.status] ?? detail.previousHandoverBooking.status}）
                      <Link
                        href={`/booking/bookings/detail?id=${encodeURIComponent(detail.previousHandoverBooking.id)}`}
                        className="text-action ml-1 underline"
                      >
                        その時の予約を見る
                      </Link>
                    </span>
                  ) : null}
                </Row>
              ) : null}
              <Row label="これまでの予約">
                {(detail.historyTotal ?? detail.history.length) === 0 ? (
                  <span className="text-ink-faint">この予約がはじめてです</span>
                ) : (
                  <>
                    {detail.history.length < (detail.historyTotal ?? detail.history.length) ? (
                      <span>
                        最新{formatNumber(detail.history.length)}件を表示（全{formatNumber(detail.historyTotal)}件）
                      </span>
                    ) : (
                      <span>{detail.historyTotal ?? detail.history.length}件</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryOpen((open) => !open)}
                      className="text-action ml-2 text-xs underline"
                      aria-expanded={historyOpen}
                    >
                      {historyOpen ? '内訳を閉じる' : '内訳を見る'}
                    </button>
                    {detail.history.length < (detail.historyTotal ?? detail.history.length) ? (
                      detail.customer.friendId ? (
                        <Link
                          href={`/friends/detail?id=${encodeURIComponent(detail.customer.friendId)}`}
                          className="text-action ml-2 text-xs underline"
                        >
                          顧客カルテで以前の予約を見る
                        </Link>
                      ) : (
                        <Link
                          href={`/booking/bookings?q=${encodeURIComponent(detail.customer.displayName)}`}
                          className="text-action ml-2 text-xs underline"
                        >
                          予約一覧でこのお客様の予約を見る
                        </Link>
                      )
                    ) : null}
                  </>
                )}
              </Row>
              {historyOpen && detail.history.length > 0 ? (
                <ol className="border-hairline mt-1 space-y-1.5 border-t pt-3">
                  {detail.history.map((item) => (
                    <li key={item.id} className="text-ink-secondary flex flex-wrap gap-x-3 text-xs">
                      <span className="tabular-nums">{jpStamp(item.startsAt)}</span>
                      <span className="min-w-0">
                        {item.menuName}／{item.staffName}
                      </span>
                      <span>{STATUS_LABELS[item.status] ?? item.status}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          </div>

          <div data-design="Right" className="w-full shrink-0 space-y-4 xl:w-96">
            {/* ---- 確認が必要なことのまとめ (IDEA-27) ---- */}
            <section className="bg-canvas rounded-card border-hairline border p-5">
              <h2 className="text-ink mb-3 text-sm font-semibold">確認が必要なこと</h2>
              {attentionItems.length === 0 ? (
                <p className="text-ink-faint text-xs">確認が必要なことはありません。</p>
              ) : (
                <ul className="space-y-2">
                  {attentionItems.map((item) => (
                    <li key={item.key} className="text-ink-secondary text-xs">
                      {item.href ? (
                        <TextLink href={item.href} inline>
                          {item.text}
                        </TextLink>
                      ) : (
                        item.text
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              id="sec-actions"
              data-design="sec この予約をどうするか"
              className="bg-canvas rounded-card border-hairline border p-5"
            >
              <h2 className="text-ink mb-1 text-sm font-semibold">この予約をどうするか</h2>
              <p className="text-ink-faint mb-3 text-xs">
                {/* DEEP-20: 実際の副作用に合わせる。承認は方針ONの連携済み
                    予約だけLINEを送り、完了・来店なし・キャンセルは送らない。 */}
                {!isLineLinked
                  ? 'LINEと結びついていないため、お客様への自動連絡はありません。'
                  : status === 'requested'
                    ? (detail.notificationPolicy.send_line_confirmation
                      ? '承認するとお客様のLINEに確定のお知らせが届きます。'
                      : 'この予約は確定のお知らせを送らない設定です。承認してもLINEには届きません。')
                    : '完了・来店なし・キャンセルの操作では、お客様への自動連絡はありません。'}
              </p>
              <div className="flex flex-col gap-2">
                {/* N-401: 閲覧のみの人には状態を変える操作を出さない */}
                {staffResolved && !canOperate && editable && (
                  <p className="text-ink-faint text-sm">
                    閲覧のみの権限のため、状態の変更はできません。
                  </p>
                )}
                {canOperate && status === 'requested' && (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => setDecideTarget('approve')}
                      disabled={acting}
                    >
                      承認する
                    </Button>
                    <Button
                      onClick={() => void startEdit()}
                      disabled={acting}
                    >
                      内容を変える
                    </Button>
                    <button
                      onClick={() => setDecideTarget('reject')}
                      disabled={acting}
                      className="text-danger hover:bg-danger-bg rounded-control px-4 py-2 text-sm font-medium"
                    >
                      拒否する
                    </button>
                  </>
                )}
                {canOperate && status === 'confirmed' && (
                  <>
                    <Button
                      variant="primary"
                      onClick={() => setDecideTarget('complete')}
                      disabled={acting}
                    >
                      完了にする
                    </Button>
                    <Button
                      onClick={() => void startEdit()}
                      disabled={acting}
                    >
                      内容を変える
                    </Button>
                    <Button
                      onClick={() => setDecideTarget('no_show')}
                      disabled={acting}
                    >
                      来店なし
                    </Button>
                    <button
                      onClick={() => setDecideTarget('cancel')}
                      disabled={acting}
                      className="text-danger hover:bg-danger-bg rounded-control px-4 py-2 text-sm font-medium"
                    >
                      キャンセル
                    </button>
                  </>
                )}
                {!editable && (
                  <p className="text-ink-faint text-sm">
                    この状態からは変えられません。新しく予約を取り直してください。
                  </p>
                )}
              </div>
            </section>

            {/* ---- 送信状況と再試行 (N-393) ---- */}
            {(failedNotificationOps.length > 0 || failedCalendarOps.length > 0) && (
              <section id="sec-failures" className="bg-canvas rounded-card border-hairline border p-5">
                <h2 className="text-ink mb-3 text-sm font-semibold">届かなかった処理</h2>
                <ul className="space-y-3">
                  {failedNotificationOps.map((op) => (
                    <li key={op.id} className="text-sm">
                      <p className="text-ink">
                        LINEのお知らせ（{notificationResultUnknown(op) ? '送達不明・要確認（自動では送り直しません）' : OPERATION_STATUS_LABELS[op.status] ?? op.status}）
                      </p>
                      {op.errorCode ? (
                        <p className="text-ink-faint text-xs">原因: {op.errorCode}</p>
                      ) : null}
                      {isLineLinked && canOperate && !notificationResultUnknown(op) ? (
                        <button
                          type="button"
                          onClick={() => void retryNotification(op.id)}
                          disabled={retrying !== null}
                          className="text-action mt-1 text-xs underline"
                        >
                          {retrying === op.id ? '再送中…' : 'もう一度送る'}
                        </button>
                      ) : null}
                    </li>
                  ))}
                  {failedCalendarOps.map((op) => (
                    <li key={op.id} className="text-sm">
                      <p className="text-ink">
                        Googleカレンダーへの反映（{notificationResultUnknown(op) ? '送達不明・要確認（自動では送り直しません）' : OPERATION_STATUS_LABELS[op.status] ?? op.status}）
                      </p>
                      {op.errorCode ? (
                        <p className="text-ink-faint text-xs">原因: {op.errorCode}</p>
                      ) : null}
                      {canOperate ? (
                        <button
                          type="button"
                          onClick={() => void retryCalendar()}
                          disabled={retrying !== null || queuedCalendar}
                          className="text-action mt-1 text-xs underline"
                        >
                          {retrying === 'calendar' ? '再試行中…' : 'もう一度反映する'}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {isLineLinked && detail.notificationPolicy.send_line_confirmation ? (
              <section className="bg-canvas rounded-card border-hairline border p-5">
                <h2 className="text-ink mb-1 text-sm font-semibold">承認したときの通知</h2>
                <p className="text-ink-faint mb-3 text-xs">現在の設定で送る場合の内容です。送信済みのお知らせとは異なる場合があります。</p>
                <div className="bg-canvas-sunken rounded-card p-3">
                  <p className="text-ink-faint mb-1 text-xs">LINE公式アカウント</p>
                  {approvedText(detail) !== null ? (
                    <p className="text-ink rounded-card bg-canvas px-4 py-3 text-sm leading-6 whitespace-pre-wrap">
                      {approvedText(detail)}
                    </p>
                  ) : (
                    <Notice
                      tone="warn"
                      message="送信内容を確認できませんでした。もう一度読み込んで確認してください。"
                      action={<Button size="compact" variant="secondary" onClick={() => void load()}>通知文を読み直す</Button>}
                    />
                  )}
                </div>
              </section>
            ) : null}

            {isLineLinked ? (
              <section id="sec-reminders" className="bg-canvas rounded-card border-hairline border p-5">
                <h2 className="text-ink mb-3 text-sm font-semibold">お知らせの予定</h2>
                {detail.reminders.length === 0 ? (
                  <p className="text-ink-faint text-xs">今後のお知らせはありません。</p>
                ) : (
                  <ol className="space-y-2">
                    {detail.reminders.map((reminder) => (
                      <li key={reminder.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-ink">
                          {POLICY_FIELD_LABELS[reminder.kind] ?? reminder.kind}　{jpStamp(reminder.scheduledAt)}
                        </span>
                        <span className="text-ink-faint">
                          {reminder.status === 'pending' ? '送信予定'
                            : reminder.status === 'sent' ? '送信済み'
                            : reminder.status === 'cancelled' ? '停止済み'
                            : '失敗'}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ) : null}

            {/* ---- 変更履歴 (N-394 / IDEA-27) ---- */}
            <section id="sec-history" className="bg-canvas rounded-card border-hairline border p-5">
              <h2 className="text-ink mb-3 text-sm font-semibold">この予約の記録</h2>
              {shownAuditLogs.length === 0 ? (
                // DEEP-19: 監査行のない予約（記録開始前のデータなど）に、
                // LINE連携の有無から「送信しました」を推測して書かない。
                // 出せるのは申込経路と通知実行台帳の事実だけ。
                <div className="space-y-3">
                  <ol className="space-y-3">
                    <LogRow
                      at={jpStamp(detail.requestedAt)}
                      text={detail.source === 'liff'
                        ? 'お客様が予約を申し込みました'
                        : 'スタッフが予約を記録しました'}
                    />
                    {notificationOps.map((op) => (
                      <LogRow
                        key={op.id}
                        at={jpStamp(op.completedAt ?? op.scheduledAt ?? detail.requestedAt)}
                        text={notificationOpLine(op)}
                      />
                    ))}
                  </ol>
                  {notificationOps.length === 0 && (
                    <p className="text-ink-faint text-xs">通知履歴はありません。</p>
                  )}
                </div>
              ) : (
                <>
                  <ol className="space-y-3">
                    {shownAuditLogs.map((log) => (
                      <LogRow key={log.id} at={jpStamp(log.occurredAt)} text={auditLine(log)} />
                    ))}
                  </ol>
                  {/* IDEA-27: 初期表示は要点分だけ。残りは audit-logs 口から追加取得する。
                      取り損ねても前の一覧は消さず、再試行できるようにする。 */}
                  {auditError ? (
                    <p className="text-danger mt-3 text-xs">{auditError}</p>
                  ) : null}
                  {auditTruncated ? (
                    <p className="text-ink-faint mt-3 text-xs">
                      これより古い記録は省略しています。
                    </p>
                  ) : null}
                  {auditRemaining > 0 && !auditTruncated ? (
                    <button
                      type="button"
                      onClick={() => void loadMoreAudit()}
                      disabled={auditLoading}
                      className="text-action mt-3 text-xs underline"
                    >
                      {auditLoading ? '読み込み中…' : `あと${formatNumber(auditRemaining)}件の記録を読み込む`}
                    </button>
                  ) : null}
                </>
              )}
            </section>
          </div>
        </div>
      )}

      {/* DEEP-18: 対象の詳細が確定していない間は確認窓を開かない。
          DEEP-20: 説明は操作と通知方針ごとの実処理に合わせる。 */}
      <ConfirmDialog
        open={decideTarget !== null && detail !== null}
        title={`この予約を「${decideTarget ? ACTION_LABELS[decideTarget] : ''}」にしますか？`}
        description={decideTarget && detail
          ? decideDescription(decideTarget, isLineLinked, detail.notificationPolicy)
          : ''}
        confirmLabel={decideTarget ? ACTION_LABELS[decideTarget] : '実行する'}
        cancelLabel="戻る"
        destructive={decideTarget === 'reject' || decideTarget === 'cancel' || decideTarget === 'no_show'}
        busy={acting}
        onCancel={closeDecideTarget}
        error={error || undefined} onSuccess={closeDecideTarget} onConfirm={() => decideTarget ? decide(decideTarget) : false}
      ><OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} /></ConfirmDialog>
    </div>
  )

}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-hairline flex gap-4 border-b py-2.5 last:border-b-0">
      <span className="text-ink-faint w-28 shrink-0 pt-0.5 text-xs font-medium">{label}</span>
      <div className="text-ink flex-1 text-sm break-words">{children}</div>
    </div>
  )
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="text-ink-secondary block text-xs">
      <span className="mb-1.5 block font-medium">{label}</span>
      {children}
    </label>
  )
}

function LogRow({ at, text }: { at: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="text-ink-faint w-32 shrink-0 text-xs tabular-nums">{at}</span>
      <span className="text-ink-secondary text-xs">{text}</span>
    </li>
  )
}
