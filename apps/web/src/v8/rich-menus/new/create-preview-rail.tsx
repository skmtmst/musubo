'use client'

import { knownValue } from '@/lib/known-value'

import type { AccountWithStats } from '@/contexts/account-context'


import { areaDisplayName } from '@/components/rich-menus/canvas-editor'
import { type Area } from '../../../components/rich-menus/area-types'
import { emptyValue } from '@/components/shared/empty-value'
import LinePreview from '@/components/shared/line-preview'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import {
type RichMenuGroupListItem,
type RichMenuTargetPreview
} from '@/lib/api'
import { type HqRichMenuPreview } from '@/lib/api/helpers/hq-authoring'
import { formatNumber } from '@/lib/format'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { JSX } from 'react'
import { HQ_REFERENCE_LABEL } from './create-model'
import { MenuContent,MetricValue } from './create-preview'
import { type Group,type Page } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'

type RenderMenuLinePreviewContext = {
  activePage: Page
  chatBarText: string
  group: Group | null
  host: RichMenuCreateHost | undefined
  previewAreas: { x: number; y: number; w: number; h: number; }[] | null
  previewImageUrl: string | null
  previewPage: Page | null
  previewPages: { id: string; name: string; }[]
  selectedAccount: AccountWithStats | null
  size: "large" | "compact"
}

export function renderMenuLinePreview({ activePage, chatBarText, group, host, previewAreas, previewImageUrl, previewPage, previewPages, selectedAccount, size }: RenderMenuLinePreviewContext) {
    return (
      <LinePreview
        accountName={host ? '公式アカウント' : selectedAccount?.name}
        note="メニューの見え方の見本です。"
        chatBarText={chatBarText}
        richMenu={(
          <MenuContent
            size={group?.size ?? size}
            imageUrl={previewImageUrl}
            areas={previewAreas}
            pages={previewPages}
            activePageId={previewPage?.id ?? activePage?.id ?? null}
          />
        )}
      />
    )
  }

type RenderPreviewRailContext = {
  activePage: Page
  audience: "all" | "tag" | "none" | "targeted"
  conditionEmpty: boolean
  conditionUnsaved: boolean
  configuredCount: number
  currentDefaultMenu: RichMenuGroupListItem | undefined
  group: Group | null
  host: RichMenuCreateHost | undefined
  hqPreview: HqRichMenuPreview | null
  pages: Page[]
  previewImageUrl: string | null
  renderLinePreview: () => JSX.Element
  selectedArea: Area | null
  step: "audience" | "shape" | "buttons" | "publish"
  tabCount: number
  targetPreview: RichMenuTargetPreview | null
  targetPreviewError: string
  targetPreviewLoading: boolean
  totalAreaCount: number
}

export function renderPreviewRail({ activePage, audience, conditionEmpty, conditionUnsaved, configuredCount, currentDefaultMenu, group, host, hqPreview, pages, previewImageUrl, renderLinePreview, selectedArea, step, tabCount, targetPreview, targetPreviewError, targetPreviewLoading, totalAreaCount }: RenderPreviewRailContext, inDialog = false) {
    return (
      <>
        {step === 'shape' ? (
          <CreateSummaryCard
            title={host ? '配る前に見ておくところ' : '公開前に見ておくところ'}
            rows={[
              {
                key: 'actions',
                label: 'ボタンの動き',
                value: (
                  <span className={totalAreaCount === 0 ? styles.summaryValueWarn : configuredCount === totalAreaCount ? styles.summaryValueOk : undefined}>
                    {totalAreaCount === 0
                      ? '面がありません'
                      : configuredCount === 0
                        ? `未設定 ${totalAreaCount}`
                        : configuredCount < totalAreaCount
                          ? `未設定 ${totalAreaCount - configuredCount}`
                          : 'すべて設定済み'}
                  </span>
                ),
              },
              {
                key: 'image',
                label: '画像',
                value: (
                  <span className={previewImageUrl ? styles.summaryValueOk : styles.summaryValueWarn}>
                    {previewImageUrl ? 'OK' : 'まだ選んでいません'}
                  </span>
                ),
              },
              {
                key: 'tabs',
                label: '切替タブ',
                value: (group ? pages.length : tabCount + 1) > 1 ? `${group ? pages.length : tabCount + 1}ページ` : emptyValue('none'),
              },
            ]}
          />
        ) : null}

        {step === 'buttons' && host ? (
          <CreateSummaryCard
            title="各アカウントで使うもの"
            rows={host.selectedCount === 0
              ? [{ key: 'accounts', label: '配るアカウント', value: 'まだ選んでいません' }]
              : (hqPreview && hqPreview.references.length === 0 ? [{ key: 'none', label: '配った先で探すもの', value: emptyValue('none') }] : hqPreview?.references ?? []).map((ref) => 'sourceId' in ref ? ({
                key: `${ref.kind}:${ref.sourceId}`,
                label: `${knownValue(HQ_REFERENCE_LABEL, ref.kind, '参照')}「${ref.name ?? '名前なし'}」`,
                value: <span className={ref.availableAccountCount < ref.totalAccountCount ? styles.summaryValueWarn : undefined}>{`${ref.availableAccountCount} / ${ref.totalAccountCount}`}</span>,
              }) : ref)}
          >
            <p className={styles.cardNote}>
              {host.selectedCount === 0
                ? '予約ページ・回答フォーム・タグ・差し込みは、配った先の各アカウントの同じ名前のものを使います。配る先は③で選びます。'
                : `今選んでいる ${formatNumber(host.selectedCount)} アカウントのうち、同じ名前があるアカウントの数。無いアカウントは④で知らせます。`}
            </p>
          </CreateSummaryCard>
        ) : null}

        {step === 'buttons' && !host ? (() => {
          const selectedAreaIndex = selectedArea && activePage
            ? activePage.areas.findIndex((a) => a.id === selectedArea.id)
            : -1
          const hasSelectedArea = Boolean(selectedArea && activePage && selectedAreaIndex >= 0)
          return (
          <CreateSummaryCard
            title="押された回数（今月）"
            rows={
              hasSelectedArea && selectedArea
                ? [
                    {
                      key: selectedArea.id,
                      label: `${String.fromCharCode(65 + selectedAreaIndex)} ${areaDisplayName(selectedArea, selectedAreaIndex)}`,
                      value: '—（公開前）',
                    },
                  ]
                : []
            }
          >
            {hasSelectedArea ? null : <p className={styles.cardNote}>面を選ぶと、ここに数が出ます。</p>}
            <p className={styles.tapNote}>
              「リッチメニューを切り替える」「日時を選ぶ」などLINEの中で終わる動きは、押されたことがこちらに届きません。
            </p>
          </CreateSummaryCard>
          )
        })() : null}

        {(step === 'audience' || step === 'publish') && host ? (
          <CreateSummaryCard
            title={step === 'audience' ? '配る先' : '配ると'}
            rows={[
              { key: 'accounts', label: '配るアカウント', value: host.selectedCount > 0 ? formatNumber(host.selectedCount) : 'まだ選んでいません' },
              {
                key: 'friends',
                label: step === 'audience' && host.selectedCount > 0 ? `出る人（${formatNumber(host.selectedCount)} アカウントの合計）` : '出る人（合計）',
                value: audience !== 'all'
                  ? '各アカウントで決める'
                  : host.selectedCount === 0
                    ? emptyValue('none')
                    : host.friendTotal == null || !Number.isFinite(host.friendTotal) ? emptyValue('unknown') : `${formatNumber(host.friendTotal)} 人`,
              },
              ...(step === 'audience' && host.selectedCount > 0 && hqPreview ? [{
                key: 'same-name',
                label: '同じ名前のメニューがある',
                value: <span className={hqPreview.summary.sameNameAccountCount > 0 ? styles.summaryValueWarn : undefined}>{formatNumber(hqPreview.summary.sameNameAccountCount)}</span>,
              }] : []),
            ]}
          />
        ) : null}
        {step === 'audience' && !host ? (
          <CreateSummaryCard
            title="出る人数"
            rows={[
              {
                key: 'effective',
                label: 'このメニューが出る人',
                value: audience === 'targeted' && conditionEmpty ? '0人' : targetPreviewLoading ? '確認中…' : <MetricValue metric={targetPreview?.effective} />,
              },
              {
                key: 'overlap',
                label: '上の順番で別のメニューが出る人',
                value: audience === 'targeted' && conditionEmpty ? '0人' : targetPreviewLoading ? '確認中…' : <MetricValue metric={targetPreview?.overlap} />,
              },
            ]}
          >
            {targetPreviewError ? <p className={styles.fieldError}>{targetPreviewError}</p> : null}
            {conditionUnsaved && !conditionEmpty ? <p className={styles.cardNote}>人数はまだ保存していない条件で数えています</p> : null}
          </CreateSummaryCard>
        ) : null}

        {step === 'publish' && !host ? (
          <CreateSummaryCard
            title="公開すると"
            rows={[
              ...(audience === 'all'
                ? [
                    // 長い名前でも1行のまま（省略は title で全文）。「→」でつなぐと行が増えるので、今と公開後を別の行にする。
                    { key: 'default-now', label: '今の既定', value: currentDefaultMenu?.name ?? '（なし）' },
                    { key: 'default-next', label: '公開後の既定', value: 'このメニュー' },
                  ]
                : []),
              {
                key: 'audience',
                label: '出る人',
                value: audience === 'targeted' && conditionEmpty ? '0人' : targetPreviewLoading ? '確認中…' : <MetricValue metric={targetPreview?.effective} />,
              },
            ]}
          >
            {conditionUnsaved && !conditionEmpty ? <p className={styles.cardNote}>（未保存の条件）</p> : null}
          </CreateSummaryCard>
        ) : null}

        {inDialog ? renderLinePreview() : <div className={`flex w-full min-w-0 flex-col ${styles.stackSection} ${styles.railPhone}`}>
          {renderLinePreview()}
        </div>}
      </>
    )
  }
