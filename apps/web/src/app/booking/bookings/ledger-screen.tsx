'use client'
import { formatDay, formatListDateTime } from '@/lib/format'
import { formatYen } from '@line-crm/shared';

import ReservationBoard from '@/components/shared/reservation-board'
import { BookingSourceLegend, BookingStatus } from '@/components/shared/booking-presentation'
import { reservationBookingState } from '@/components/shared/booking-state'

import { PeopleDayList } from '@/v8/booking-bookings/public/day-list/index'

import { PeopleDayFrame } from '@/v8/booking-bookings/public/day-frame/index'

import { peopleBoardEntry, withHonorific } from '@line-crm/shared'

import { reservationBoardApi, allBoardPages } from '@/lib/api/helpers/reservation-board'

import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'

import KpiBand from '@/components/shared/kpi-band'

import KpiCard from '@/components/shared/kpi-card'

import { PageHeading } from '@/components/templates/page-frame'

import SegmentedControl from '@/components/shared/segmented'

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import Link from 'next/link'

import { Calendar, CalendarPlus, CalendarX, CircleAlert, Download, Phone, X } from 'lucide-react'

import { bookingApi, type BookingAdminDetail, type BookingRequest } from '@/lib/api'

import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

import { BookingGapSections } from '@/v8/booking-gap/public/booking-gap-sections/index'

import { SeriesHost } from '@/v8/booking-gap/public/series-host/index'

import Button from '@/components/shared/button'

import ListToolbar from '@/components/shared/list-toolbar'

import ListState from '@/components/shared/list-state'
import StaleStyleNotice from '@/components/shared/stale-style-notice'

import { isForbiddenOrRateLimited } from '@/components/shared/api-error-message'

import Notice from '@/components/shared/notice'

import { BookingLedgerFrame } from '@/v8/booking-bookings/public/ledger-frame/index'

import { BookingLedgerBody } from '@/v8/booking-bookings/public/ledger-body/index'

import { monthKey, monthLabel } from '@/v8/booking-bookings/public/month-navigation/index'

import FilterChip from '@/components/shared/filter-chip'

import { ListToolbarEnd, ListToolbarRow, ListToolbarSearchSlot} from '@/components/shared/list-toolbar'

import { RowMenu } from '@/components/shared/row-actions'

import { BookingChipsLabel, BookingMonthBar, BookingUrlCopy } from '@/v8/booking-bookings/public/month-bar/index'

import ledgerStyles from '@/v8/booking-bookings/month-bar.module.css'

import Select from '@/components/shared/select'

import { ActionCell, DataTable, DateCell, StatusCell, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'

import Pagination from '@/components/shared/pagination'

import ListRange from '@/components/ui/list-range'

import FolderPanel from '@/components/shared/folder-panel'

import DetailPanel from '@/components/shared/detail-panel'

import ContextMenu from '@/components/shared/context-menu'

import BookingDetailV8 from './booking-detail'

import { BookingChargesSection } from '@/v8/booking-payments/public/booking-charges/index'

import { isLineBooking, moveDay } from './booking-calendar'

import { formatNumber } from '@/lib/format'

import { DetailRow, ActionButtons } from "./page-gap-parts"

import { STATUS_TABS, SOURCE_FILTER_OPTIONS, SOURCE_FILTER_NAME, sourceFilterText, statusBadgeColor, sourceLabel, statusLabel, actionLabel, PAGE_SIZE, formatJpDateTime, formatJpTime, formatJpDay, jstDay } from './ledger-model'

import type { BookingLedgerModel } from './use-booking-ledger'
import { bookingWords } from '@/v8/booking-bookings/public/words/index'
import { reminderDeliveryStatusLabel } from '@/lib/status-labels'
import { TextField as SharedTextField } from '@/components/shared/text-field'

export default function BookingLedgerScreen({ model }: { model: BookingLedgerModel }) {
  if (model.selectedAccountId && model.styleProfile && !model.styleProfile.data) return <BookingLedgerFrame view={model.view}>
    <PageHeading title="予約管理" />
    <ListState kind={model.styleProfile.error ? 'error' : 'loading'} title={model.styleProfile.error ? '使い方のスタイルを読み込めませんでした' : '使い方のスタイルを確認しています'} error={model.styleProfile.error ?? undefined} onRetry={model.styleProfile.reload} />
  </BookingLedgerFrame>
  const usageStyle = model.styleProfile?.data?.style
  const words = bookingWords(usageStyle)
  const {
    selectedAccountId,
    selectedAccount,
    urlParams,
    view,
    setView,
    tab,
    setTab,
    range,
    setRange,
    menuFilter,
    setMenuFilter,
    staffFilter,
    setStaffFilter,
    sourceFilter,
    setSourceFilter,
    staffList,
    staffBreaks,
    boardStaff,
    setBoardStaff,
    query,
    setQuery,
    page,
    setPage,
    items,
    total,
    calendarItems,
    calendarLoad,
    calendarAnchor,
    setCalendarAnchor,
    monthOffset,
    setMonthOffset,
    calendarFrom,
    calendarTo,
    availability,
    summary,
    menus,
    summaryError,
    summaryReady,
    setSummarySeq,
    setCalendarSeq,
    loading,
    error,
    setError,
    loadError,
    decideTarget,
    deciding,
    decideError,
    csvBusy,
    canOperate,
    setDetailId,
    setActiveBookingId,
    canRefundCharges,
    openBookingDetail,
    closeBookingDetail,
    workerBase,
    shareUrl,
    historyUrl,
    isCopied,
    copyFailedUrl,
    copyUrl,
    load,
    downloadLedgerCsv,
    calendarStatus,
    confirmDecide,
    cancelDecide,
    handleDecide,
    kpi,
    menuCounts,
    pageCount,
    current,
    shown,
    nonTabNarrowing,
    showFilteredEmpty,
    clearListFilters,
    detail,
    activeBooking,
    activeBookingIndex,
    bookingContextItems,
    visits,
    todayCount,
    weekCount,
    monthCount,
  } = model

  const headingActions = (
    <>
      <SegmentedControl
        aria-label="予約の表示"
        size="booking"
        value={view}
        onChange={setView}
        options={[
          { value: 'day', label: '今日', count: summaryReady ? todayCount : undefined },
          { value: 'week', label: '今週', count: summaryReady ? weekCount : undefined },
          { value: 'month', label: '今月', count: summaryReady ? monthCount : undefined },
          { value: 'list', label: '一覧' },
        ]}
      />
      {canOperate ? <Button variant="primary" size="booking" href="/booking/bookings/new"><Phone size={16} aria-hidden="true" />電話の予約を入れる</Button> : null}
    </>
  )
  const pageHead = <PageHeading title="予約管理" help={view === 'month' ? '予約を探して、行から詳細を見られます。CSVは今の絞り込みで書き出します。' : undefined} actions={headingActions} />

  const dialogs = (
    <>
      {detail && ((
        /*
         * ★V8-B 予約の詳細（`AjZhH`）。管理画面 の引き出しは残し、
         * V8 の表示 のときだけ小窓にする。
         */
        <BookingDetailV8
          usageStyle={usageStyle}
          booking={detail}
          accountId={selectedAccountId}
          canOperate={canOperate}
          onClose={() => setDetailId(null)}
          onCancel={() => handleDecide(detail.id, 'cancel')}
          detailHref={`/booking/bookings/detail?id=${encodeURIComponent(detail.id)}`}
        />
      ))}
      {selectedAccountId && canOperate ? <SeriesHost params={new URLSearchParams(urlParams.toString())} accountId={selectedAccountId} menus={menus} staffList={staffList} basePath="/booking/bookings" /> : null}
      <ConfirmDialog
        open={decideTarget !== null && decideTarget.accountId === selectedAccountId}
        designNode={decideTarget?.action === 'cancel' ? 'iJdAi' : undefined}
        title={`この予約を「${decideTarget ? actionLabel[decideTarget.action] : ''}」にしますか？`}
        description={
          // N-390: LINE未連携の予約へ「届きます」と出すと事実と違う。
          decideTarget && (calendarItems.find((b) => b.id === decideTarget.id) ?? items.find((b) => b.id === decideTarget.id))?.friend_id
            ? '予約した人へ、この結果がLINEで届きます。取り消すには、もう一度状態を変える必要があります。'
            : `LINEと結びついていないため、${words.person}への自動連絡はありません。取り消すには、もう一度状態を変える必要があります。`
        }
        confirmLabel={decideTarget ? actionLabel[decideTarget.action] : '実行する'}
        cancelLabel="戻る"
        destructive={decideTarget?.action === 'reject' || decideTarget?.action === 'cancel' || decideTarget?.action === 'no_show'}
        busy={deciding}
        error={decideError || undefined}
        onCancel={() => cancelDecide(decideTarget)}
        onConfirm={() => confirmDecide(decideTarget)}
      ><OperationTargetSummary accounts={[{ id: decideTarget?.accountId ?? '' }]} /></ConfirmDialog>
    </>
  )

  {/* 帯同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}
  if (view === 'day' || view === 'week') {
    return (
      <PeopleDayFrame usageStyle={usageStyle} view={view} date={calendarFrom} rows={calendarItems} ready={calendarStatus === 'ready'} availability={availability} actions={headingActions} canWrite={canOperate} onOpen={setDetailId}>
        {model.styleProfile?.error ? <ListState kind="error" title="使い方のスタイルを読み込めませんでした" error={model.styleProfile.error} onRetry={model.styleProfile.reload} /> : null}
        {model.styleProfile?.stale ? <StaleStyleNotice onRetry={model.styleProfile.reload} /> : null}
        {/*
          ★V7 `x63W5x`：同じ失敗を1画面に1つへ。失敗の1枚はカレンダーの場所に
          出す（#634 の読み直す口は保つ）。一覧が読めている間はカレンダーを出す。
        */}
        {error || calendarStatus === 'error' ? (
          <ListState
            kind="error"
            title="予約を読み込めませんでした"
            // m23m: 403・429は共通の1枚（権限の案内・待ち案内）へ切り替える。
            // それ以外は画面の文のまま。
            description={isForbiddenOrRateLimited(loadError) ? undefined : '通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。'}
            error={calendarStatus === 'error' ? calendarLoad.error : loadError ?? undefined}
            onRetry={() => { setError(''); setCalendarSeq((n) => n + 1); void load() }}
          />
        ) : (
          <ReservationBoard breaks={view === 'day' ? staffBreaks : undefined} timeDirection={view === 'day' ? 'vertical' : undefined} printContext={`${selectedAccount?.name??selectedAccountId??'予約管理'} ／ ${sourceFilterText(sourceFilter)}`} kind="people" dates={Array.from({length:view==='week'?7:1},(_,i)=>moveDay(calendarFrom,i))}
            toolbar={<><Button size="compact" onClick={()=>setCalendarAnchor(moveDay(calendarAnchor,view==='week'?-7:-1))}>‹</Button><strong>{Number(calendarFrom.slice(5,7))}月{Number(calendarFrom.slice(8))}日{view==='week'?`〜${Number(calendarTo.slice(5,7))}月${Number(calendarTo.slice(8))}日`:null}</strong><Button size="compact" onClick={()=>setCalendarAnchor(moveDay(calendarAnchor,view==='week'?7:1))}>›</Button><Button size="compact" onClick={()=>setCalendarAnchor(jstDay(new Date().toISOString()))}>今日</Button></>}
            title={`${calendarFrom}〜${calendarTo}の予約`} loadPrintEntries={selectedAccountId?()=>allBoardPages('people',selectedAccountId,new Date(calendarFrom+'T00:00:00+09:00').toISOString(),new Date(moveDay(calendarTo,1)+'T00:00:00+09:00').toISOString()):undefined}
            notice={calendarStatus==='loading'?<ListState kind="loading"/>:availability.status==='error'?<Notice tone="danger">空き枠を読み込めませんでした。予約の記録だけを表示しています。<Button onClick={()=>setSummarySeq(n=>n+1)}>もう一度読み込む</Button></Notice>:availability.status==='loading'?<p>空き枠を読み込んでいます</p>:availability.status==='unconfigured'?<Notice tone="warn" action={<Button href="/booking/menus">設定する</Button>}>担当者か予約メニューが未設定です。予約設定で登録すると空き枠が出ます。</Notice>:null}
            slots={availability.status==='ready'?availability.slots.filter(s=>s.remaining>0&&['available','limited'].includes(s.state)).map(s=>({resourceId:staffList.find(t=>t.display_name===s.staffName)?.id??'',startsAt:s.startUtc??`${s.date}T${s.start}:00+09:00`,href:`/booking/bookings/new?${new URLSearchParams({date:s.date,time:s.start,staff:s.staffName,menu:s.menuId})}`})):[]} entries={(calendarStatus==='ready'?calendarItems:[]).map(r=>peopleBoardEntry({...r,customer_name:r.friend_name,lock_version:(r as unknown as {lock_version:number}).lock_version,line_account_id:selectedAccountId}))}
            legend={view==='day'||view==='week'?<BookingSourceLegend sources={['line','phone']}/>:undefined}
            trailingToolbar={view==='day'||view==='week'?<><EntitySelect width={146} aria-label={`${words.staff}で絞り込む`} valuePrefix={`${words.staff}：`} value={boardStaff} onChange={setBoardStaff} options={[{value:'all',label:'すべて'},...staffList.map(r=>({value:r.id,label:r.display_name}))]}/><Select size="content" label={SOURCE_FILTER_NAME} aria-label="予約元で絞り込む" value={sourceFilter} onChange={setSourceFilter} options={SOURCE_FILTER_OPTIONS}/></>:undefined}
            resources={staffList.filter(r=>view!=='day'||boardStaff==='all'||r.id===boardStaff).map(r=>({id:r.id,label:r.display_name,active:true,capacity:1}))}
            onOpen={setDetailId} canWrite={canOperate}
            renderList={view === 'day' ? () => <PeopleDayList usageStyle={usageStyle} rows={calendarStatus === 'ready' ? calendarItems : []} canMark={canOperate} visits={visits} onOpen={setDetailId} /> : undefined}
            onMove={async(id,move)=>{if(!selectedAccountId)throw new Error('アカウント未取得');await reservationBoardApi.move(selectedAccountId,id,move);setCalendarSeq(n=>n+1);await load()}}
          />
        )}
        {dialogs}
      </PeopleDayFrame>
    )
  }

  return (
    <BookingLedgerFrame view={view}>
      {pageHead}
      {model.styleProfile?.error ? <ListState kind="error" title="使い方のスタイルを読み込めませんでした" error={model.styleProfile.error} onRetry={model.styleProfile.reload} /> : null}
        {model.styleProfile?.stale ? <StaleStyleNotice onRetry={model.styleProfile.reload} /> : null}
      <BookingLedgerBody view={view} readOnly={!canOperate}
        stats={<>
          {summaryError && (
            // 集計の失敗でも一覧は使える。
            <p className="text-ink-secondary text-xs" role="status">
              集計を読み込めませんでした。一覧はそのまま使えます。
              <button type="button" className="text-action ml-2 font-semibold hover:underline" onClick={() => setSummarySeq((n) => n + 1)}>もう一度読み込む</button>
            </p>
          )}

          {/* 未取得の数と、取得済みの0件を区別する。 */}
          <KpiBand data-design="KPIs">
            <KpiCard icon={view === 'month' ? <Calendar size={16} aria-hidden="true" /> : null} presentation="band"
              title="今月の予約"
              value={summaryReady ? kpi.total : null}
              unit="件"
              detail={summaryError ? '読み込めませんでした' : !summaryReady ? '読み込んでいます' : `前月比 ${kpi.diff >= 0 ? '+' : ''}${kpi.diff}`}
            />
            <KpiCard icon={view === 'month' ? <CalendarPlus size={16} aria-hidden="true" /> : null} presentation="band" title="確定" help={view === 'month' ? (usageStyle === 'consult' || usageStyle === 'lesson' ? `今月の予約のうち、確定した${words.planned}の件数です。` : '今月の予約のうち、確定して来店を予定している件数です。') : undefined} helpDisplay="question" value={summaryReady ? kpi.confirmed : null} unit="件" detail={summaryError ? '読み込めませんでした' : !summaryReady ? '読み込んでいます' : words.planned} />
            {/* 設計は「変更依頼 / 要対応」。bookings の状態に「変更依頼」が無いので
                承認待ちを出す。要対応であることは変わらない。 */}
            <KpiCard icon={view === 'month' ? <CircleAlert size={16} aria-hidden="true" /> : null} presentation="band"
              title="変更依頼"
              value={summaryReady ? summary.requested : null}
              unit="件"
              badge={view === 'month' && summaryReady && summary.requested > 0 ? '要対応' : undefined}
              badgeTone="warning"
              detail={summaryError ? '読み込めませんでした' : !summaryReady ? '読み込んでいます' : view === 'month' ? `${words.person}から ${summary.requested}件` : '要対応'}
            />
            <KpiCard icon={view === 'month' ? <CalendarX size={16} aria-hidden="true" /> : null} presentation="band"
              title="キャンセル"
              value={summaryReady ? kpi.cancelled : null}
              unit="件"
              detail={summaryError ? '読み込めませんでした' : !summaryReady ? '読み込んでいます' : kpi.rate === null ? '率 —' : `率 ${kpi.rate}%`}
            />
          </KpiBand>
          <BookingMonthBar
            monthLabel={view === 'month' ? monthLabel(monthKey(monthOffset)) : undefined}
            isThisMonth={monthOffset === 0}
            onPrev={() => setMonthOffset((n) => n - 1)}
            onNext={() => setMonthOffset((n) => n + 1)}
            onToday={() => setMonthOffset(0)}
            urls={shareUrl ? <>
              <BookingUrlCopy label="友だち予約URL" copied={isCopied(shareUrl)} onCopy={() => void copyUrl(shareUrl)} />
              {historyUrl ? <BookingUrlCopy label="予約履歴URL" copied={isCopied(historyUrl)} onCopy={() => void copyUrl(historyUrl)} /> : null}
            </> : null}
            caption={view === 'month' ? <>{monthOffset === 0 ? `今月（${monthLabel(monthKey(0))}）` : monthLabel(monthKey(monthOffset))}の予約を「{STATUS_TABS.find(item => item.key === tab)?.label ?? ''}」で表示しています。</> : undefined}
          />
        </>}
        folders={<FolderPanel
            heading="メニュー"
            rows={[
              { id: 'all', label: 'すべて', count: summary.total },
              ...menus.map((menu) => ({
                id: menu.name,
                label: menu.name,
                count: menuCounts.get(menu.name) ?? 0,
              })),
            ]}
            activeId={menuFilter}
            onSelect={setMenuFilter}
            total={`${formatNumber(summary.total)} 件`}
          />}
        folderNav={{
          label: words.menu,
          activeId: menuFilter,
          onSelect: setMenuFilter,
          rows: [{ id: 'all', label: 'すべて', count: summary.total }, ...menus.map(menu => ({ id: menu.name, label: menu.name, count: menuCounts.get(menu.name) ?? 0 }))],
        }}
        toolbar={view === 'month' ? <>
          {/* R8tlbw：1段目＝探す・担当・経路 … CSV、2段目＝「よく使う」と状態の札。 */}
          <ListToolbarRow>
            <ListToolbarSearchSlot search={{ placeholder: `${words.person}名で検索`, value: query, onChange: setQuery }} />
            <EntitySelect
              aria-label={`${words.staff}で絞り込む`}
              valuePrefix={`${words.staff}: `}
              value={staffFilter}
              onChange={setStaffFilter}
              options={[
                { value: 'all', label: 'すべて' },
                ...staffList.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.display_name })),
              ]}
            />
            <Select
              label={SOURCE_FILTER_NAME}
              aria-label="予約元で絞り込む"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={SOURCE_FILTER_OPTIONS}
            />
            {selectedAccountId ? <ListToolbarEnd>
              <Button variant="secondary" disabled={csvBusy} onClick={downloadLedgerCsv} busy={csvBusy} busyLabel="書き出しています…"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>
            </ListToolbarEnd> : null}
          </ListToolbarRow>
          <ListToolbarRow>
            <BookingChipsLabel />
            <SegmentedControl aria-label="予約の状態" fit="content" value={tab} onChange={setTab} options={STATUS_TABS.map(({ key, label }) => ({ value: key, label }))} />
          </ListToolbarRow>
        </> : <>
            <ListToolbar
            search={{ placeholder: `${words.person}名で検索`, value: query, onChange: setQuery }}
            filters={
              <>
                <>
                {range === 'date' ? <FilterChip selected onChange={() => setRange('all')} title="押すと日付の絞り込みを解除します">{formatDay(calendarAnchor)}の予約</FilterChip> : null}
                <span className="text-ink-faint text-xs">よく使う</span>
                <SegmentedControl aria-label="予約の状態" fit="content" value={tab} onChange={setTab} options={STATUS_TABS.map(({ key, label }) => ({ value: key, label }))} />
                <SegmentedControl aria-label="予約の期間" fit="content" value={range} onClear={() => setRange('all')} onChange={setRange} options={[
                  { value: 'all', label: 'すべて' }, { value: 'today', label: '今日' }, { value: 'week', label: '今週' },
                ]} />

                </>
                {/* 担当者と予約経路は一覧と件数の両方を絞り込む。 */}
                <EntitySelect
                  aria-label={`${words.staff}で絞り込む`}
                  value={staffFilter}
                  onChange={setStaffFilter}
                  options={[
                    { value: 'all', label: `${words.staff}：すべて` },
                    ...staffList.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.display_name })),
                  ]}
                />
                <Select
                  label={SOURCE_FILTER_NAME}
                  aria-label="予約元で絞り込む"
                  value={sourceFilter}
                  onChange={setSourceFilter}
                  options={SOURCE_FILTER_OPTIONS}
                />
              </>
            }
            trailing={
              /* CSVにも画面と同じ絞り込みを使う。 */
              selectedAccountId ? (
                <Button variant="secondary" disabled={csvBusy} onClick={downloadLedgerCsv} busy={csvBusy} busyLabel="書き出しています…">CSVで書き出す
                </Button>
              ) : null
            }
          />
        </>}
        pagination={view === 'month'
          ? <Pagination page={current} pageCount={pageCount} onPageChange={setPage} range={{ total, first: (current - 1) * PAGE_SIZE + 1, last: Math.min(current * PAGE_SIZE, total) }} />
          : <div data-design="tf" className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <ListRange
              total={total}
              first={(current - 1) * PAGE_SIZE + 1}
              last={Math.min(current * PAGE_SIZE, total)}
            />
            <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
          </div>}>
        {!selectedAccountId ? (
            <div className="bg-canvas rounded-card border-hairline text-ink-faint border p-12 text-center text-sm">
              サイドバーでアカウントを選択してください
            </div>
          ) : loading ? (
            <div className="bg-canvas rounded-card border-hairline border">
              <ListState kind="loading" loadingShape="board" title="予約を読み込んでいます" />
            </div>
          ) : error ? (
            // ★管理画面 `x63W5x`：失敗を「まだありません」と言わない。
            // 空の案内と作成ボタンは出さない。
            <div className="bg-canvas rounded-card border-hairline border">
              <ListState
                kind="error"
                title="予約を読み込めませんでした"
                // m23m: 403・429は共通の1枚（権限の案内・待ち案内）へ切り替える。
                // それ以外は画面の文のまま。
                description={isForbiddenOrRateLimited(loadError) ? undefined : '通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。'}
                error={loadError ?? undefined}
                onRetry={() => void load()}
              />
            </div>
          ) : shown.length === 0 ? (
            <div className="bg-canvas rounded-card border-hairline border">
              {showFilteredEmpty ? (
                <ListState
                  kind="empty"
                  title="条件に合う予約はありません"
                  description="検索語や絞り込みを変えてください。"
                  action={nonTabNarrowing || tab !== 'all' ? <Button variant="secondary" onClick={clearListFilters}>絞り込みを解除</Button> : undefined}
                />
              ) : (
                <ListState
                  kind="empty"
                  title="まだ予約はありません"
                  description={`予約が入ると、ここに日時と${words.person}が並びます。`}
                  action={canOperate ? <Button variant="primary" size="booking" href="/booking/bookings/new">電話の予約を入れる</Button> : undefined}
                />
              )}
            </div>
          ) : (
            <DataTable className="@container" data-design="Table">
              {/* @container: 谷間帯の列削減。表の幅が足りない間だけ「担当」を畳む。
                  担当は予約の詳細で読める補助情報。畳んでいる間も操作列は右端に留める。 */}
                  <thead>
                    <TableHeadRow>
                      <Th style={{ width: '15%' }}>日時</Th>
                      <Th style={{ width: '13%' }}>{words.person}</Th>
                      <Th style={{ width: '17%' }}>{words.menu}</Th>
                      <Th style={{ width: '10%' }} className="cq-hide-below-830">{words.staff}</Th>
                      <Th style={{ width: '9%' }}>予約経路</Th>
                      <Th style={{ width: '9%' }} align="right">料金</Th>
                      <Th style={{ width: '11%' }}>状態</Th>
                      <Th style={{ width: 64 }} align="right">操作</Th>
                    </TableHeadRow>
                  </thead>
                  <tbody>
                    {shown.map((b) => (
                      <Tr
                        key={b.id}
                        interactive
                        className="group"
                        {...({
                              tabIndex: 0,
                              onClick: () => openBookingDetail(b.id),
                              onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                                if (event.target !== event.currentTarget) return
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  openBookingDetail(b.id)
                                }
                              },
                            })}
                      >
                        <DateCell title={formatJpDateTime(b.starts_at)}>{formatListDateTime(b.starts_at)}</DateCell>
                        <Td>
                          {/* R11: 行の物は予約のため、お客さま名から別画面へ飛ばさない。名前は黒文字。 */}
                          <ContextMenu label={`予約「${b.friend_name ?? words.person}」の操作`} items={bookingContextItems(b)}>
                            <span className={ledgerStyles.name} title={b.friend_name ?? (b.friend_id ? '-' : `LINE未連携の${words.person}`)}>
                              {b.friend_name ?? (b.friend_id ? '-' : `LINE未連携の${words.person}`)}
                            </span>
                          </ContextMenu>
                        </Td>
                        <Td><span className={ledgerStyles.cellText} title={b.menu_name}>{b.menu_name}</span></Td>
                        <Td className="cq-hide-below-830"><span className={ledgerStyles.cellText} title={b.staff_name ?? undefined}>{b.staff_name}</span></Td>
                        {/* R88: 受付経路は source で分ける。担当者の代理入力をLINEにしない。 */}
                        <Td>{isLineBooking(b) ? 'LINE' : sourceLabel(b)}</Td>
                        <Td align="right" className="tabular-nums">
                          {formatYen(b.price_at_booking)}
                        </Td>
                        <StatusCell primary={<BookingStatus state={reservationBookingState({status:b.status,holdExpiresAt:null})}>{statusLabel[b.status] ?? b.status}</BookingStatus>} />
                        <ActionCell>
                          {/* 行全体が詳細パネルを開くので、操作列の押下は行へ伝えない。
                              行の右端は「…」1つ（B-253）。詳細・会話・承認などは中へ。承認待ちは状態の札で分かる。 */}
                          <span className={ledgerStyles.actions} onClick={(event) => event.stopPropagation()}>
                            <RowMenu
                              label={`予約「${b.friend_name ?? words.person}」の操作`}
                              items={bookingContextItems(b).map((item) => ({ id: item.id, label: item.label, tone: item.danger ? 'danger' as const : undefined, onSelect: () => item.onSelect?.(item.id) }))}
                            />
                          </span>
                        </ActionCell>
                      </Tr>
                    ))}
                  </tbody>
            </DataTable>
          )}

          {/* URLは数の帯の下の［コピーする］から。ここは作れないときの案内と、コピーできなかったときに全文を選ぶ欄だけ。 */}
          {!shareUrl || copyFailedUrl ? <div data-design="note" className="bg-canvas-sunken rounded-card mt-3 p-3">
            <p className="text-ink-secondary text-xs leading-5">
              友だち予約URLと、友だちが自分の予約履歴を見るURLをそれぞれ発行できます。予約履歴URLを配ると「自分の予約を確認したい」という問い合わせを減らせます。
            </p>
            {shareUrl ? (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SharedTextField
                    readOnly
                    value={shareUrl}
                    aria-label="友だち予約URL"
                    onFocus={(e) => e.currentTarget.select()}
                    className="border-hairline bg-canvas rounded-control min-w-0 flex-1 border px-3 py-2 font-mono text-xs"
                  />
                  <Button variant="primary" className="px-4 py-2 font-medium border-0 h-auto whitespace-normal" type="button" onClick={() => copyUrl(shareUrl)}>
                    {isCopied(shareUrl) ? 'コピー済' : 'コピー'}
                  </Button>
                  <span className="text-ink-faint text-xs">{`${words.person}が新しく予約を入れるURL`}</span>
                </div>
                {/* N-396: 履歴URLは別画面を開く。両方発行できることを注記と揃える。 */}
                {historyUrl ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <SharedTextField
                      readOnly
                      value={historyUrl}
                      aria-label="予約履歴URL"
                      onFocus={(e) => e.currentTarget.select()}
                      className="border-hairline bg-canvas rounded-control min-w-0 flex-1 border px-3 py-2 font-mono text-xs"
                    />
                    <Button variant="primary" className="px-4 py-2 font-medium border-0 h-auto whitespace-normal" type="button" onClick={() => copyUrl(historyUrl)}>
                      {isCopied(historyUrl) ? 'コピー済' : 'コピー'}
                    </Button>
                    <span className="text-ink-faint text-xs">{`${words.person}が自分の予約履歴を見るURL`}</span>
                  </div>
                ) : null}
                {copyFailedUrl && (copyFailedUrl === shareUrl || copyFailedUrl === historyUrl) ? (
                  <p role="alert" className="text-warning text-xs">
                    コピーできませんでした。左の欄を選んでコピーしてください。
                  </p>
                ) : null}
              </div>
            ) : !workerBase ? (
              // 配信先のURLが作れないのは、LIFF未設定ではなくAPI接続先の欠落(点検#516軽4)。
              <p className="text-warning mt-2 text-xs">
                予約URLを作れません。APIの接続先が設定されていません。管理者に連絡してください。
              </p>
            ) : (
              <p className="text-warning mt-2 text-xs">
                このアカウントには LIFF ID が未設定です。
                <Link href="/accounts" className="ml-1 underline">
                  アカウント設定
                </Link>
                で LIFF ID を登録してください。
              </p>
            )}
          </div> : null}
      </BookingLedgerBody>

      {/* V8「サクサク感」C①・E：表の行の詳細パネル。確認の窓は残す。v7は引き出しのまま。 */}
      {(
        <DetailPanel
          open={activeBooking !== null}
          title={activeBooking ? `${activeBooking.friend_name ?? words.person} ／ ${activeBooking.menu_name}` : ''}
          description={
            activeBooking
              ? `${formatJpDateTime(activeBooking.starts_at)}〜${formatJpTime(activeBooking.ends_at)}・${statusLabel[activeBooking.status] ?? activeBooking.status}`
              : undefined
          }
          onClose={closeBookingDetail}
          hasPrev={activeBookingIndex > 0}
          hasNext={activeBookingIndex >= 0 && activeBookingIndex < shown.length - 1}
          onPrev={activeBookingIndex > 0 ? () => setActiveBookingId(shown[activeBookingIndex - 1].id) : undefined}
          onNext={
            activeBookingIndex >= 0 && activeBookingIndex < shown.length - 1
              ? () => setActiveBookingId(shown[activeBookingIndex + 1].id)
              : undefined
          }
          footer={activeBooking ? (
            <>
              {/* 絵 Nx1kq の言葉（日時を変える）。来店にするを並べても 360 の帯で 1 行に収める。 */}
              <Button href={`/booking/bookings/detail?id=${encodeURIComponent(activeBooking.id)}`} variant="secondary">
                日時を変える
              </Button>
              {/* 来店にする（Nx1kq・司令塔の判断）：確定の予約だけ。今ある「完了」の確かめの窓を通す。閲覧のみには出さない。 */}
              {canOperate && activeBooking.status === 'confirmed' ? (
                <Button variant={activeBooking.friend_id ? 'secondary' : 'primary'} onClick={() => handleDecide(activeBooking.id, 'complete')}>
                  {usageStyle === 'consult' || usageStyle === 'lesson' ? words.completeAction : '来店にする'}
                </Button>
              ) : null}
              {activeBooking.friend_id ? (
                <Button href={`/chats?friend=${activeBooking.friend_id}`} variant="primary">
                  この人と話す
                </Button>
              ) : null}
            </>
          ) : undefined}
        >
          {activeBooking ? (
            <div>
              {selectedAccountId ? <div className="mb-4 flex flex-col gap-4"><BookingGapSections accountId={selectedAccountId} bookingId={activeBooking.id} seriesId={(activeBooking as { series_id?: string | null }).series_id ?? null} customerName={activeBooking.friend_name ?? words.person} menuName={activeBooking.menu_name} startsAt={activeBooking.starts_at} canOperate={canOperate} onChanged={() => void load()} /></div> : null}
              <DetailRow label="日時">
                {formatJpDateTime(activeBooking.starts_at)} 〜 {formatJpTime(activeBooking.ends_at)}
              </DetailRow>
              <DetailRow label={words.staff}>{activeBooking.staff_name}</DetailRow>
              <DetailRow label="料金">
                <span className="tabular-nums">{formatYen(activeBooking.price_at_booking)}</span>
              </DetailRow>
              <DetailRow label="予約経路">{isLineBooking(activeBooking) ? 'LINE' : '電話・店頭'}</DetailRow>
              <DetailRow label="状態">{statusLabel[activeBooking.status] ?? activeBooking.status}</DetailRow>
              <DetailRow label="予約番号">
                <span className="text-ink-secondary font-mono text-xs">{activeBooking.id}</span>
              </DetailRow>
              <DetailRow label={`${words.person}からのご希望`}>
                {activeBooking.customer_note ?? <span className="text-ink-faint">記入なし</span>}
              </DetailRow>
              {/* この組（B5・Nx1kq）と お支払い（B1・Ae1W1・fom2A）。口が無い・対象でない予約は出さない。 */}
              {selectedAccountId ? <div className="mt-3 flex flex-col gap-3">
                <BookingChargesSection accountId={selectedAccountId} bookingId={activeBooking.id} customerName={activeBooking.friend_name ?? words.person}
                  bookingLabel={`${formatJpDateTime(activeBooking.starts_at)} ${activeBooking.menu_name}`} price={activeBooking.price_at_booking ?? null}
                  canCharge={canOperate} canRefund={canOperate && canRefundCharges} />
              </div> : null}
              <p className="mt-3 text-xs">
                <Link
                  href={`/booking/bookings/detail?id=${encodeURIComponent(activeBooking.id)}`}
                  className="text-action font-semibold hover:underline focus-visible:underline"
                >
                  予約の詳細ページを開く →
                </Link>
              </p>
            </div>
          ) : null}
        </DetailPanel>
      )}

      {dialogs}
    </BookingLedgerFrame>
  )

}

function BookingDetailPanel({
  booking: b,
  accountId,
  canOperate,
  onClose,
  onAction,
}: {
  booking: BookingRequest
  accountId: string | null
  /** N-401: 閲覧のみの人には状態を変える操作を出さない。 */
  canOperate: boolean
  onClose: () => void
  onAction: (a: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete') => void
}) {
  const [detail, setDetail] = useState<BookingAdminDetail | null>(null)
  const [detailError, setDetailError] = useState('')

  useEffect(() => {
    if (!accountId) return
    let active = true
    setDetailError('')
    void bookingApi.getBooking(accountId, b.id)
      .then((response) => { if (active) setDetail(response.booking) })
      .catch(() => { if (active) setDetailError('予約の顧客カルテと通知実績を読み込めませんでした') })
    return () => { active = false }
  }, [accountId, b.id])

  const lineOperation = detail?.operations.find((item) => item.kind === 'confirmation_line') ?? null
  // N-390: LINEと結びついていない電話予約では「届きます」系の文言を畳む。
  const isLinked = detail?.customer.isLineLinked ?? Boolean(b.friend_id)
  return (
    <div data-design-node="TnDbq" className="fixed inset-y-0 right-0 left-0 z-50 flex justify-end xl:left-64">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-scrim"
      />
      <aside className="relative h-full w-full overflow-y-auto bg-canvas-sunken shadow-float">
        <div className="border-hairline sticky top-0 z-10 flex min-h-16 items-center justify-between gap-3 border-b bg-canvas px-6 py-3">
          <div className="min-w-0">
            <p className="text-ink-faint text-xs font-semibold">予約管理　›　{formatJpDay(b.starts_at)}　›　{formatJpTime(b.starts_at)} {withHonorific(b.friend_name ?? 'お客様', 'さま')}</p>
            <h2 className="text-ink mt-1 truncate text-xl font-semibold">{b.friend_name ?? 'お客様'} ／ {b.menu_name}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`rounded-pill px-3 py-1 text-xs font-semibold ${statusBadgeColor[b.status] ?? 'bg-canvas-sunken'}`}>{statusLabel[b.status] ?? b.status}</span>
            {b.friend_id ? <Button href={`/chats?friend=${b.friend_id}`} variant="primary">この人と話す</Button> : null}
            {/* N-389: 変更は詳細ページの変更フォームで行う。「準備中」のまま残さない。
                N-401: 閲覧のみの人には変更・取消の入口を出さない。 */}
            {canOperate ? (
              <>
                <Button href={`/booking/bookings/detail?id=${encodeURIComponent(b.id)}`} variant="secondary">時間や担当を変える</Button>
                <Button onClick={() => onAction('cancel')} className="border-danger text-danger">予約を取り消す</Button>
              </>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="rounded-mini p-1.5 text-ink-secondary hover:bg-canvas-sunken"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div data-design="Body" className="grid gap-4 px-6 py-4 xl:grid-cols-4">
          <div className="min-w-0 xl:col-span-3">
          {detailError ? <Notice tone="danger" message={detailError} onClose={() => setDetailError('')} className="mb-4" /> : null}
          <section className="mb-6">
            <div className="bg-success-bg text-success mb-3 w-fit rounded-pill px-3 py-1 text-xs font-semibold">予約が入っています</div>
            <p className="text-ink-secondary mb-3 text-sm">{formatJpDateTime(b.starts_at)}〜{formatJpTime(b.ends_at)} ／ 担当 {b.staff_name} ／ {isLineBooking(b) ? 'LINEから入りました。' : '電話・店頭で受け付けました。'}</p>
            <div className="bg-canvas rounded-card border-hairline border p-5">
            <h3 className="text-ink mb-1 text-base font-semibold">予約の中身</h3>
            <DetailRow label="メニュー">{b.menu_name}</DetailRow>
            <DetailRow label="日時">
              {formatJpDateTime(b.starts_at)} 〜 {formatJpTime(b.ends_at)}
            </DetailRow>
            <DetailRow label="担当">{b.staff_name}</DetailRow>
            <DetailRow label="料金">
              <span className="tabular-nums">¥{formatNumber(b.price_at_booking)}</span>
            </DetailRow>
            <DetailRow label="予約番号">
              <span className="text-ink-secondary font-mono text-xs">{b.id}</span>
            </DetailRow>
            <DetailRow label="お客様からのご希望">{b.customer_note ?? <span className="text-ink-faint">記入なし</span>}</DetailRow>
            </div>
          </section>

          <section className="bg-canvas rounded-card border-hairline border p-5">
            <h3 className="text-ink text-base font-semibold">この方のこれまで</h3>
            <p className="text-ink-faint mt-1 text-xs">顧客カルテの履歴は、友だち詳細で確認できます。前回のことを覚えていると、話が早くなります。</p>
            <div className="border-hairline mt-4 grid grid-cols-4 gap-3 border-b pb-2 text-xs text-ink-faint"><span>いつ・何を</span><span>担当</span><span>金額</span><span>メモ</span></div>
            {(detail?.history.length ? detail.history : [{ id: b.id, startsAt: b.starts_at, menuName: b.menu_name, staffName: b.staff_name, price: b.price_at_booking, customerNote: b.customer_note, handoverNote: null, status: b.status }]).slice(0, 3).map((item) => (
              <div key={item.id} className="grid grid-cols-4 gap-3 py-3 text-sm"><span>{formatJpDateTime(item.startsAt)} {item.menuName}</span><span>{item.staffName}</span><span>¥{formatNumber(item.price)}</span><span>{item.customerNote ?? '記入なし'}</span></div>
            ))}
            {b.friend_id ? <Link href={`/friends/detail?id=${encodeURIComponent(b.friend_id)}`} className="text-action text-xs font-semibold hover:underline focus-visible:underline">顧客カルテで以前の予約を見る →</Link> : null}
          </section>

          <section className="bg-canvas rounded-card border-hairline border p-5">
            <h3 className="text-ink text-base font-semibold">この予約で動いたこと</h3>
            <div className="mt-3 space-y-3 text-sm">
              <p>✓ {formatJpDateTime(b.requested_at)} 予約を受け付けました</p>
              {b.decided_at ? <p>✓ {formatJpDateTime(b.decided_at)} 予約を「{statusLabel[b.status] ?? b.status}」にしました</p> : null}
              {lineOperation ? <p>{lineOperation.status === 'succeeded' ? '✓' : '…'} 予約確認LINE: {lineOperation.status === 'succeeded' ? '送信済み' : lineOperation.status === 'queued' ? '送信中' : lineOperation.status === 'retry_wait' ? '再試行中' : lineOperation.status === 'permanent_failed' ? '失敗' : '送信なし'}</p> : null}
              {detail?.reminders.map((reminder) => <p key={reminder.id}>{reminder.status === 'sent' ? '✓' : '…'} {formatJpDateTime(reminder.scheduledAt)} リマインダ：{reminderDeliveryStatusLabel(reminder.status)}</p>)}
              {isLinked ? <p className="text-ink-faint">お知らせの開封状況は、受信箱で確認できます。</p> : null}
            </div>
          </section>
          </div>

          <aside className="space-y-4">
          <section className="bg-canvas rounded-card border-hairline border p-5">
            <h3 className="text-ink text-sm font-semibold">お客様とペット</h3>
            <div className="mt-3 flex items-center gap-3"><span className="bg-action-soft text-action flex h-10 w-10 items-center justify-center rounded-pill font-semibold">{b.friend_name?.charAt(0) ?? '?'}</span><div>{b.friend_id ? <Link href={`/friends/detail?id=${encodeURIComponent(b.friend_id)}`} className="text-ink font-semibold hover:underline">{withHonorific(b.friend_name ?? '名前未設定', 'さま')}</Link> : <span className="text-ink font-semibold">{withHonorific(b.friend_name ?? '名前未設定', 'さま')}</span>}<p className="text-ink-faint text-xs">{b.friend_id ? 'LINEの友だち情報と来店履歴' : '電話受付のお客さま'}</p></div></div>
            <DetailRow label="ペット">{detail?.customer.petName ?? '登録なし'}</DetailRow>
            <DetailRow label="連絡先">{detail?.customer.phone ?? '登録なし'}</DetailRow>
            {detail?.customer.tags.length ? <DetailRow label="タグ">{detail.customer.tags.map((tag) => tag.name).join('、')}</DetailRow> : null}
            {detail?.customer.mileageBalance !== null && detail?.customer.mileageBalance !== undefined ? <DetailRow label="マイル">{formatNumber(detail.customer.mileageBalance)}</DetailRow> : null}
          </section>
          <Notice tone="warn" heading={<> <h3>当日 気をつけること</h3> </>}>

            <p className="mt-3 text-xs">{detail?.previousHandover ?? '前回の申し送りはありません。'}</p>
          </Notice>
          <section className="bg-canvas rounded-card border-hairline border p-5">
            <h3 className="text-ink text-sm font-semibold">つながる先</h3>
            <div className="mt-3 space-y-2 text-xs"><p><Link href="/booking/menus" className="text-action font-semibold hover:underline focus-visible:underline">→ 予約設定</Link>　メニューと受付枠</p><p><Link href="/reminders" className="text-action font-semibold hover:underline focus-visible:underline">→ リマインダ</Link>　前日・開始前のお知らせ</p>{b.friend_id ? <p><Link href={`/chats?friend=${b.friend_id}`} className="text-action font-semibold hover:underline focus-visible:underline">→ 受信箱</Link>　この方とのやりとり</p> : null}<p><Link href="/mileage" className="text-action font-semibold hover:underline focus-visible:underline">→ マイル</Link>　来店時の付与</p></div>
          </section>
          <div className="bg-canvas rounded-card border-hairline border p-5">
            <p className="text-ink-faint mb-2 text-xs">
              {isLinked
                ? '承認するとお客様のLINEに確定のお知らせが届きます。'
                : 'LINEと結びついていないため、お客様への自動連絡はありません。'}
            </p>
            {canOperate ? <ActionButtons status={b.status} onAction={onAction} /> : null}
            <Link
              href={`/booking/bookings/detail?id=${encodeURIComponent(b.id)}`}
              data-qa-open="TnDbq"
              aria-label={`${b.friend_name ?? 'この予約'}の予約の詳細ページを開く`}
              className="text-ink-secondary mt-3 inline-block text-xs underline"
            >
              予約の詳細ページを開く
            </Link>
          </div>
          </aside>
        </div>
        {canOperate ? (
          <div className="border-hairline sticky bottom-0 z-10 flex items-center justify-between gap-4 border-t bg-canvas px-6 py-3"><p className="text-ink-faint text-xs">{isLinked ? 'ここでの状態変更は、お客様のLINEにも自動で知らせます。' : 'LINEと結びついていないため、お客様への自動連絡はありません。'}</p><div className="flex gap-2"><Button onClick={() => onAction('cancel')}>キャンセル</Button><Button onClick={() => onAction('complete')}>来ていただきました にする</Button></div></div>
        ) : null}
      </aside>
    </div>
  )
}
