'use client'

import { useState, type ReactNode } from 'react'
import ChannelsSummaryBand, { type ChannelsSummary } from './channels-summary'
import { Check, Smartphone } from 'lucide-react'
import { CreatePage } from '@/components/templates/create-page'
import PreviewLauncher from '@/components/templates/preview-launcher'
import { notifyToast } from '@/components/shared/toast'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { Tabs } from '@/components/shared/tabs'
import { V8TabEditContext, AccountIcon, StateCard } from './tabs/shared'
import styles from './settings.module.css'
import ChannelsTabV8 from './channels-tab'
import { PassesTabV8 } from '@/v8/booking-passes/index'
import type { useBookingSettings } from './use-booking-settings'
import { MenusTabV8, HoursTabV8, HolidaysTabV8, RulesTabV8, StaffTabV8, PaymentsTabV8, PaymentsSideV8, PhotosTabV8, V8_TABS } from './settings-parts'
import { useSearchParams } from 'next/navigation'

export default function BookingSettingsView({ accountId, tab, previewUrl, tabNode, canEditMenus, canEditSettings, tabReadOnly, menus, menusStatus, menusError, settings, settingsStatus, settingsError, staff, staffStatus, staffError, staffMatrices, staffExtras, members, resources, resourcesStatus, resourcesError, closedBookingCount, storeExceptions, tabEdit, hasChanges, registerTabEdit, switchTarget, setSwitchTarget, requestTab, confirmSwitch, reloadCore, saveSettings, saveResource, createResource, deleteResource, retryResources, closedWeekdays, phone }: ReturnType<typeof useBookingSettings> & { phone: ReactNode }) {
  const [channelsSummary, setChannelsSummary] = useState<ChannelsSummary | null>(null)
  /* お支払いタブ：記録・届いた知らせ（?view=）は横いっぱい。設定のときは右の欄に「メニューごとの支払い方法」。 */
  const paymentsView = useSearchParams().get('view')
  const [paymentsConnected, setPaymentsConnected] = useState(true)
  /* つなぐ前（UteeA）も右の欄を出さない。 */
  const paymentsWide = tab === 'payments' && (paymentsView === 'records' || paymentsView === 'events')
  /* 担当スタッフは割り当て方（QJMoY）が入って横いっぱいの表になった。スマホの見本は出さない。 */
  const withoutPreview = tab === 'photos' || tab === 'channels' || tab === 'payments' || tab === 'staff' || tab === 'passes'
  const currentSummary: ChannelsSummary = channelsSummary?.accountId === accountId ? channelsSummary : { accountId: accountId ?? '', status: 'loading', data: null, conflicts: 0 }
  const previewContent = <>
            <div className={styles.sideActions}>
              {previewUrl ? <Button href={previewUrl} external fullWidth><Smartphone size={16} aria-hidden="true" />お客さまに見える画面を確かめる</Button> : null}
            </div>
            <p className={styles.sideTitle}>お客さまの予約画面</p>
            {phone}
            {previewUrl ? null : (
              <p className={styles.sideLineLink}>このアカウントには予約画面のURLがまだありません</p>
            )}
  </>

  return (
    <V8TabEditContext.Provider value={registerTabEdit}>
      <CreatePage
        boardId={tab === 'menus' && !canEditMenus ? 'C9fv7A' : tabNode}
        dirty={false}
        readOnly={Boolean(accountId && tabReadOnly)} title={<>予約設定</>}
        help={<>
          お客さまの予約画面に出るメニュー・時間・ルールを決めます
          {tab === 'channels' ? <>。いちばん確かなのは「スタッフの Google カレンダー」です。
            ほかの予約サービスがスタッフの Google カレンダーへ予約を書き出せれば、
            その時間は自動で LINE の予約受付から外れます（いまの作りでできます）。
            Google カレンダーに書き出せない入り口は、予約通知メールを取り込みアドレスへ転送して読み取ります（見本のメールがそろった媒体から順に）。</> : null}
        </>}
        tabs={<Tabs
              label="予約設定のタブ"
              items={V8_TABS.map((item) => ({
                label: item.label,
                current: item.key === tab,
                onClick: () => requestTab(item.key),
              }))}
            />}


        actions={tab === 'passes' ? <PermissionGatedButton allowed={canEditSettings} variant="primary" href="/booking/passes/new">回数券・月謝を作る</PermissionGatedButton> : undefined}
        preview={tab === 'payments' && accountId && !paymentsWide ? <PaymentsSideV8 accountId={accountId} menus={menus} connected={paymentsConnected} /> : withoutPreview ? undefined : previewContent}
        previewToggle={tab === 'payments' && accountId && !paymentsWide ? (
          /* 狭い幅（1152）：右の欄を畳み、「メニューごとの支払い方法」を窓で開く。 */
          <PreviewLauncher title="メニューごとの支払い方法" label="メニューごとの支払い方法を見る"><PaymentsSideV8 accountId={accountId} menus={menus} connected={paymentsConnected} /></PreviewLauncher>
        ) : withoutPreview ? undefined : (
          /* 絵 ：畳んだときも「LINEでの見え方を見る」と「お客さまに見える画面を確かめる」の2つを並べる。 */
          <div className={styles.narrowActions}>
            <PreviewLauncher title="お客さまの予約画面" label="LINEでの見え方を見る">{previewContent}</PreviewLauncher>
            {previewUrl ? <Button href={previewUrl} external><Smartphone size={16} aria-hidden="true" />お客さまに見える画面を確かめる</Button> : null}
          </div>
        )}
        contentSpacing={accountId && (tab === 'channels' || (tab === 'menus' && menusStatus === 'ready')) ? 'notice-after-preview' : undefined}
        footerActions={tabEdit && tabEdit.showBar !== false && !tabEdit.saveDisabled ? (
                <>
                  <Button onClick={() => tabEdit.onReset()} disabled={tabEdit.saving}>キャンセル</Button>
                  <Button
                    variant="primary"
                    icon={<Check size={16} aria-hidden="true" />}
                    onClick={() => {
                      if (!hasChanges) {
                        notifyToast('変更はありません。')
                        return
                      }
                      tabEdit.onSave()
                    }}
                    disabled={tabEdit.saving}
                    busy={tabEdit.saving}

                  >
                    {tabEdit.saveLabel ?? '保存する'}
                  </Button>
                </>
              ) : null}
        status={hasChanges && tabEdit ? `${tabEdit.subject}があります` : undefined}
      >
            {!accountId ? (
              <StateCard
                icon={<AccountIcon />}
                title="LINEアカウントを選んでください"
                description="共通メニューで、予約設定を開くLINEアカウントを選んでください。"
              />
            ) : tab === 'menus' ? (
              <MenusTabV8
                accountId={accountId}
                menus={menus}
                status={menusStatus}
                error={menusError}
                menuCount={settings?.menuCount}
                canEdit={canEditMenus}
                onReload={reloadCore}
                onOpenStaff={() => requestTab('staff')}
              />
            ) : tab === 'hours' ? (
              <HoursTabV8
                accountId={accountId}
                settings={settings}
                settingsStatus={settingsStatus}
                settingsError={settingsError}
                resources={resources}
                resourcesStatus={resourcesStatus}
                resourcesError={resourcesError}
                canEdit={canEditSettings}
                menus={menus}
                onSaved={saveSettings}
                onReload={reloadCore}
                onResourceSaved={saveResource}
                onResourceCreated={createResource}
                onResourceDeleted={deleteResource}
                onResourcesRetry={retryResources}
              />
            ) : tab === 'holidays' ? (
              <HolidaysTabV8
                accountId={accountId}
                settings={settings}
                status={settingsStatus}
                error={settingsError}
                exceptions={storeExceptions}
                closedWeekdays={closedWeekdays}
                bookingCountOnClosed={closedBookingCount}
                canEdit={canEditSettings}
                onSaved={saveSettings}
                onReload={reloadCore}
              />
            ) : tab === 'rules' ? (
              <RulesTabV8
                accountId={accountId}
                settings={settings}
                status={settingsStatus}
                error={settingsError}
                staff={staff}
                staffReady={staffStatus === 'ready'}
                canEdit={canEditSettings}
                onSaved={saveSettings}
                onReload={reloadCore}
              />
            ) : tab === 'staff' ? (
              <StaffTabV8
                accountId={accountId}
                staff={staff}
                status={staffStatus}
                error={staffError}
                matrices={staffMatrices}
                extras={staffExtras}
                members={members}
                canEdit={canEditSettings}
                onReload={reloadCore}
              />
            ) : tab === 'photos' ? (
              <PhotosTabV8 key={accountId} accountId={accountId} canEditMenus={canEditMenus} canEditSettings={canEditSettings} onSaved={reloadCore} />
            ) : tab === 'passes' ? (
              <PassesTabV8 accountId={accountId} canEdit={canEditSettings} />
            ) : tab === 'payments' ? (
              <PaymentsTabV8 accountId={accountId} canEdit={canEditSettings} onConnectedChange={setPaymentsConnected} />
            ) : (
              <><ChannelsSummaryBand summary={currentSummary} />
              <ChannelsTabV8 accountId={accountId} canEdit={canEditSettings} staff={staff} onSummaryChange={setChannelsSummary} /></>
            )}
      </CreatePage>

      {/* タブをまたぐときの破棄確認（タブ内のデータは外れると消える）。 */}
      <ConfirmDialog
        open={switchTarget !== null}
        title={`${tabEdit?.subject ?? '変更'}を捨てて移りますか？`}
        description="保存していない変更は消えます。"
        confirmLabel="捨てて移る"
        cancelLabel="編集に戻る"
        primaryAction="cancel"
        onCancel={() => setSwitchTarget(null)}
        onConfirm={confirmSwitch}
      />

    </V8TabEditContext.Provider>
  )
}
