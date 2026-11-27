'use client'

/** ：流入・クーポンも正本のQR窓を使う。停止経路は保存を止める。 */
import DashboardQrDialog from '@/components/dashboard/qr-dialog'
import QrRoutePicker from '@/components/dashboard/qr-route-picker'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import { api } from '@/lib/api'
import { useState } from 'react'

const WORKER_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

export const referralUrl = (refCode: string) => `${WORKER_BASE.replace(/\/$/, '')}/r/${encodeURIComponent(refCode)}`

export interface QrRoute {
  refCode: string
  name: string
  genre: string | null
  /** false（停止中）のときは QR・保存を止める。null は未登録 ref（有効・無効の概念が無い）。 */
  isActive: boolean | null
  /** entry_routes の ID。あるときだけ印刷用 PDF を出せる。 */
  id?: string
  couponEnabled?: boolean
}

export default function QrDialog({ route: initialRoute, routes, onClose }: { route: QrRoute; routes?: QrRoute[]; onClose: () => void }) {
  const [selectedRef, setSelectedRef] = useState(initialRoute.refCode)
  const route = routes?.find(item => item.refCode === selectedRef) ?? initialRoute
  const activeRoutes = (routes ?? []).filter(item => item.isActive === true && item.refCode !== route.refCode)
  const unknown = route.isActive !== true && route.isActive !== false && route.isActive !== null
  const options = [route, ...activeRoutes].map(item => ({ value: item.refCode, label: item.name,
    disabled: item.isActive !== true && item.isActive !== null,
    description: item.isActive === false ? '停止中の経路は使えません' : item.isActive !== true && item.isActive !== null ? '状態を確認できません' : undefined }))
  const selectActive = (value: string) => { if (routes?.some(item => item.refCode === value && item.isActive === true)) setSelectedRef(value) }
  if (unknown) return <Dialog open title={`${route.name} の QR コード`} onCancel={onClose}>
    {activeRoutes.length ? <QrRoutePicker value={route.refCode} options={options} onChange={selectActive} /> : null}
    <ListState kind="error" title="経路の状態を確認できません" description="一覧を再読み込みしてから、もう一度お試しください。" />
  </Dialog>
  return <DashboardQrDialog key={route.refCode} open onClose={onClose} accountName={route.name}
    disabledReason={route.isActive === false ? 'この経路は停止中です。再開するまでQRコードは使えません。' : undefined}
    baseLink={referralUrl(route.refCode)} routes={[]}
    resource={{
      routePicker: routes?.some(item => item.isActive === true) ? { value: route.refCode, options, onChange: selectActive } : undefined,
      url: referralUrl(route.refCode), title: `${route.name} の QR コード`,
      stopped: route.isActive === false, stoppedPresentation: 'notice',
      description: 'チラシ・店頭POPに印刷して使えます。読み取るとこの経路の画面が開きます。',
      downloadPdf: route.id ? paper => route.couponEnabled ? api.entryRoutes.qrPdf(route.id!, paper) : api.entryRoutes.qrPdf(route.id!) : undefined,
      downloadImage: route.id && route.couponEnabled ? (format, size) => api.entryRoutes.qrImage(route.id!, format as 'png' | 'svg', size as 'small' | 'medium' | 'large') : undefined,
      paperSizes: route.couponEnabled,
      ...(route.couponEnabled ? {
        formats: [{value:'png',label:'PNG'},{value:'svg',label:'SVG'}],
        sizes: [{value:'small',label:'小 256'},{value:'medium',label:'中 512'},{value:'large',label:'大 1024'}],
      } : {}),
    }} />
}
