'use client'
import CloseButton from '@/components/shared/close-button'
import DownloadIcon from './qr-download-icon'
import QrStoppedNotice from './qr-stopped-notice'
import QrRoutePicker, { type QrRoutePickerProps } from './qr-route-picker'
import React, { useEffect, useState } from 'react'
import { QrCode } from 'lucide-react'
import type { EntryRoute } from '@line-crm/shared'
import { api,ApiError } from '@/lib/api'
import ListState from '@/components/shared/list-state'
import { qrToDataURL } from '@/lib/qr-image'
import Button from '@/components/shared/button'
import { FieldError } from '@/components/shared/form-controls'
import Select from '@/components/shared/select'
import SegmentedControl from '@/components/shared/segmented'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import { formatDateTime } from '@/lib/format'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { TextArea as SharedTextArea } from '@/components/shared/text-field'
/** QRの取得・画像保存はWorker、PDFはブラウザの印刷で行う。 */
/*
 * 選べる大きさ（#689）。
 *
 * Worker の /api/qr は 64〜1024px、かつ縦×横が 1,048,576 まで（`normalizeQrSize`）。
 * 以前は「大」を 1200px にしていたため、正しく選んだ人だけが 400 で保存できなかった。
 * ここに足すときは、必ず 1024px 以下・面積 1,048,576 以下にする。
 */
const SIZES = [
  { value: '1024x1024', label: '大（1024px）', note: '印刷向け' },
  { value: '600x600', label: '中（600px）', note: '画面向け' },
  { value: '300x300', label: '小（300px）', note: '確認用' },
]

/** Worker の /api/qr が受ける形式。順番はよく使うものから。 */
const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'svg', label: 'SVG' },
]

export function resolveOfficialProfileUrl(
  officialProfileUrl?: string | null,
  accountBasicId?: string | null,
): string | null {
  if (officialProfileUrl !== undefined) return officialProfileUrl
  if (!accountBasicId) return null
  const basicId = accountBasicId.startsWith('@') ? accountBasicId : `@${accountBasicId}`
  return `https://line.me/R/ti/p/${basicId}`
}

export type FixedQrResource = {
  routePicker?: QrRoutePickerProps
  url: string
  title: string
  stopped?: boolean
  stoppedPresentation?: 'notice'
  description?: string
  downloadPdf?: (paper: 'A4' | 'A5') => Promise<Blob>
  downloadImage?: (format: string, size: string) => Promise<Blob>
  paperSizes?: boolean
  formats?: { value: string; label: string }[]
  sizes?: { value: string; label: string }[]
}


export default function QrDialog({
  open,
  onClose,
  accountName,
  officialProfileUrl,
  accountBasicId,
  baseLink,
  initialRouteId = '',
  onRouteIdChange,
  visualReferenceQr = false,
  routes: routesProp,
  routesPending: routesPendingProp,
  routesError: routesErrorProp,
  onRetryRoutes,
  direct,
  resource,
  disabledReason,
}: {
  direct?:{title:string;description:string;content?:React.ReactNode;footer?:React.ReactNode;qrContent?:React.ReactNode;downloads?:boolean}
  open: boolean
  /** 流入・クーポン・来店スタンプも同じ窓で出す。取得と保存は元のAPI。 */
  resource?: FixedQrResource
  disabledReason?: string
  onClose: () => void
  accountName: string
  /** LINE公式プロフィールで発行した lin.ee の短縮URL。 */
  officialProfileUrl?: string | null
  /** 公式アカウントのID（`@nen` など）。QRの下に出す案内先の組み立てに使う。 */
  accountBasicId?: string | null
  baseLink: string
  /** 呼び出し元で選んでいた経路。開いたときの初期値になる。 */
  initialRouteId?: string
  /** ダイアログ内で経路を変えたときに呼ばれる。呼び出し元はURLへ写す。 */
  onRouteIdChange?: (routeId: string) => void
  /** 撮影固定応答でだけ使うPencilの簡略見本。通常時は実URLのQRを生成する。 */
  visualReferenceQr?: boolean
  /*
    呼び出し元が既に取った経路一覧。渡されたら取り直さない。
    同じ口を外と中で2回叩かない。
  */
  routes?: EntryRoute[]
  /*
    経路一覧の取得がまだ終わっていないとき true。
    アカウント切替直後など、一覧が来る前に「経路が見つからない」と
    断定しないための目印（DASH-09）。
  */
  routesError?: boolean
  onRetryRoutes?: () => void
  routesPending?: boolean
}) {
  const [fetchedError,setFetchedError]=useState(false)
  const [readRetry,setReadRetry]=useState(0)
  const [lookupState,setLookupState]=useState<'idle'|'loading'|'error'|'missing'>('idle')
  const [fetchedRoutes, setFetchedRoutes] = useState<EntryRoute[] | null>(null)
  const routes = routesProp ?? fetchedRoutes ?? []
  const routesError = Boolean(routesErrorProp || (routesProp===undefined && fetchedError) || lookupState==='error')
  const routesPending = routesProp !== undefined ? (routesPendingProp ?? false) : fetchedRoutes === null
  const [routeId, setRouteId] = useState(initialRouteId)
  const [syncedInitialRouteId, setSyncedInitialRouteId] = useState(initialRouteId)
  const routeSelectionPending = open && initialRouteId !== syncedInitialRouteId
  /*
   * 一覧に無いIDを指定されたときだけ取り直す。止めた経路は一覧から
   * 外れるため、「見つからない」と「止めている」を分けるための1回。
   */
  const [lookedUpRoute, setLookedUpRoute] = useState<EntryRoute | null>(null)
  const sizes = resource?.sizes ?? SIZES
  const formats = resource?.formats ?? FORMATS
  const [size, setSize] = useState(sizes[0].value)
  const [paper, setPaper] = useState<'A4' | 'A5'>('A4')
  const [imageState, setImageState] = useState<'idle' | 'working' | 'failed'>('idle')
  const [format, setFormat] = useState(FORMATS[0].value)
  /* 印刷用PDFの取り寄せ状態。失敗してもダイアログは閉じない。 */
  const [pdfState, setPdfState] = useState<'idle' | 'working' | 'failed'>('idle')
  /*
   * コピーの結果は3状態。失敗しても押す前と同じ見た目だと、
   * 配布に使うURLを取れていないことに気づけない（DASH-29）。
   */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [qrDataUrl, setQrDataUrl] = useState('')

  // 開くたびに呼び出し元の選択に合わせる。閉じている間に向こうで
  // 経路を変えていたら、次に開いたときはそちらが正。
  useEffect(() => {
    if (open) {
      setRouteId(initialRouteId)
      setSyncedInitialRouteId(initialRouteId)
      setPdfState('idle')
    }
  }, [open, initialRouteId])

  useEffect(() => {
    if (!open || routesProp || resource) return
    let cancelled = false
    setFetchedError(false)
    setFetchedRoutes(null)
    void api.entryRoutes.list()
      .then((res) => {
        if(!res.success)throw new Error(res.error)
        if (!cancelled) setFetchedRoutes(res.data)
      })
      .catch(() => {
        if (!cancelled) setFetchedError(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, routesProp, resource,readRetry])

  const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
  const route = routes.find((r) => r.id === routeId)
    ?? (lookedUpRoute?.id === routeId ? lookedUpRoute : null)
  /*
   * 一覧に無いIDは1件だけ取り直す。止めた経路は「停止しています」と出し、
   * 削除・別アカウントの経路は「見つからない」と出す。基本URLのQRへ
   * 黙って置き換えない。経路を選び直すまでQR・コピー・ダウンロードを
   * 止める（DASH-09 / DASH-28 の方向）。
   */
  useEffect(() => {
    if (!open || resource || routeId === '' || routesPending || routesErrorProp) {setLookupState('idle');return}
    if (routes.some((r) => r.id === routeId)) {
      setLookedUpRoute(null)
      setLookupState('idle')
      return
    }
    let cancelled = false
    setLookedUpRoute(null)
    setLookupState('loading')
    void api.entryRoutes.get(routeId)
      .then((res) => {
        if(!res.success)throw new Error(res.error)
        if (!cancelled) {setLookedUpRoute(res.data);setLookupState('idle')}
      })
      .catch((error:unknown) => {
        if(!cancelled)setLookupState(error instanceof ApiError && error.status===404?'missing':'error')
      })
    return () => {
      cancelled = true
    }
  }, [open, routeId, routes, routesPending, resource,readRetry,routesErrorProp])
  /* 止めた経路は QR も印刷も出さない（M）。選択肢にも出さない。 */
  const routeStopped = route != null && !route.isActive
  const routeMissing = routeId !== '' && !route && !routesPending && !routesError && lookupState!=='loading'
  const link = resource?.url ?? (route && route.isActive ? `${base}/r/${route.refCode}` : baseLink)
  const blocked = resource ? Boolean(resource.stopped) : routeSelectionPending || routesError || Boolean(routeId && !route) || routeStopped

  useEffect(() => {
    let cancelled = false
    setQrDataUrl('')
    // PERF-09: 閉じている間は QR を作らない。開いた時点で qrcode を読む。
    if (!open || blocked) {
      return () => { cancelled = true }
    }
    void qrToDataURL(link, {
      width: 220,
      margin: 1,
      color: { dark: '#171717', light: '#ffffff' },
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [link, blocked, open])

  // Escape・Tabの循環・背景スクロール停止・閉じたあとのフォーカス戻しは
  // 共通のoverlay作法に揃える。保存中の処理はないためEscapeは常に閉じる。
  const panelRef = useOverlayFocus(open, onClose)

  if (!open) return null

  const pixelSize = ({small:'256x256',medium:'512x512',large:'1024x1024'} as Record<string,string>)[size] ?? size
  const qrSrc = `${base}/api/qr?size=${pixelSize}&format=${format}&data=${encodeURIComponent(link)}`
  const saveHref = `${qrSrc}&download=1&filename=${encodeURIComponent(
    route ? `qr-${route.refCode}` : 'qr-friend-add',
  )}`

  /*
   * QRの下に出す案内先。
   *
   * 経路を選んでいればその経路のリンク。経路ごとに分けて発行したのに
   * ここが公式アカウントのままだと、どのQRを見ているのか分からない。
   *
   * 基本のときはAPIが返した公式プロフィール短縮URLを優先する。
   * 段階配備中の旧Workerでは公式ID（basicId）から同じ行き先を組み立てる。
   */
  const profileUrl = route && route.isActive
    ? link
    : blocked
      ? null
      : resolveOfficialProfileUrl(officialProfileUrl, accountBasicId)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1200)
    } catch {
      /*
       * 権限拒否・安全なコンテキストでない環境では書けない。
       * 黙って終わらせず、手動で選択してコピーする案内を出す（DASH-29）。
       */
      setCopyState('failed')
    }
  }

  /*
   * 印刷用PDFはサーバーで作る（M）。止めた経路は409で断られる。
   * 基本の追加URLには経路IDが無いため、従来どおりブラウザの印刷を使う。
   */
  const downloadPdf = async () => {
    if (blocked || (!resource?.downloadPdf && (!route || !route.isActive))) return
    setPdfState('working')
    try {
      const blob = await (resource?.downloadPdf ? resource.downloadPdf(paper) : api.entryRoutes.qrPdf(route!.id))
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = `qr-${route?.refCode ?? 'print'}-${paper}.pdf`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)
      setPdfState('idle')
    } catch {
      setPdfState('failed')
    }
  }

  /* 止めた記録の表示用。読めない日時は出さない。 */
  const stoppedDetail = (() => {
    if (!routeStopped || !route) return null
    const reason = route.stoppedReason?.trim() || null
    const at = route.stoppedAt ? new Date(route.stoppedAt) : null
    const when = at && Number.isFinite(at.getTime())
      ? formatDateTime(at)
      : null
    if (reason && when) return `${reason}（${when}に停止）`
    return reason ?? (when ? `${when}に停止` : null)
  })()

  const downloadImage = async () => {
    if (blocked || !resource?.downloadImage) return
    setImageState('working')
    try {
      const blob = await resource.downloadImage(format, size)
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl; anchor.download = `qr-${size}.${format}`
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(objectUrl)
      setImageState('idle')
    } catch { setImageState('failed') }
  }

  const printQr = () => {
    const printWindow = window.open('', '_blank', 'width=720,height=820')
    if (!printWindow) return
    printWindow.opener = null
    const doc = printWindow.document
    doc.title = `${accountName} ${direct?.title??'友だち追加QRコード'}`
    const style = doc.createElement('style')
    style.textContent = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:48px;text-align:center;color:#1a1c1a}main{max-width:560px;margin:0 auto}img{width:360px;height:360px;object-fit:contain}h1{font-size:22px;margin:24px 0 8px}p{font-size:12px;color:#565f59;word-break:break-all}@media print{body{padding:20mm}}'
    doc.head.appendChild(style)
    const main = doc.createElement('main')
    const image = doc.createElement('img')
    image.alt = direct?.title??'友だち追加QRコード'
    image.src = qrSrc
    const heading = doc.createElement('h1')
    heading.textContent = accountName
    const url = doc.createElement('p')
    url.textContent = link
    main.append(image, heading, url)
    doc.body.appendChild(main)
    image.onload = () => {
      printWindow.focus()
      printWindow.print()
    }
  }

  return (
    <div
      data-design="QR"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={direct?.title ?? resource?.title ??'友だち追加のQRコード'}
        className="bg-canvas rounded-panel border-hairline max-h-[90vh] w-full overflow-y-auto border p-8 shadow-float"
        style={{ maxWidth: 820 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-ink text-base font-bold">{direct?.title ?? resource?.title ??'友だち追加のQRコード'}</h2>
            <p className="text-ink-faint mt-1 text-xs leading-relaxed">
              {direct?.description ?? resource?.description ??'チラシ・店頭POP・名刺などに印刷して使えます。読み取ると友だち追加の画面が開きます。'}
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {resource?.routePicker ? <div className="mb-4"><QrRoutePicker {...resource.routePicker} /></div> : null}
        {resource?.stopped && resource.stoppedPresentation === 'notice' ? <QrStoppedNotice onClose={onClose} /> : <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
          {routesError ? <ListState kind="error" title="経路を読み込めませんでした" onRetry={()=>{if(routesErrorProp)onRetryRoutes?.();else setReadRetry(value=>value+1)}}/> : null}
          {/* 名前はQRの下。読み取る人が見るのは絵で、名前はその確認に使う。 */}
          <div className="flex min-w-0 flex-col items-center">
            {/*
              QRの枠は横幅に応じて縮める（DASH-13）。320pxでは280px固定だと
              パネルの内側に収まらず横にはみ出していた。正方形は保つ。
            */}
            <div className={`bg-canvas-sunken rounded-panel flex w-full max-w-[280px] items-center justify-center ${blocked ? 'py-4' : 'aspect-square'}`}>
              {direct?.qrContent ? direct.qrContent : (routeStopped || resource?.stopped) ? (
                <p className="text-ink-secondary px-4 text-center text-xs leading-relaxed" role="alert">
                  この経路は停止しています。QRコードは表示しません。
                  {stoppedDetail ? <><br />{stoppedDetail}</> : null}
                </p>
              ) : routeSelectionPending || routesError || lookupState==='loading' ? null : routeMissing ? (
                <p className="text-ink-faint max-w-[220px] px-4 text-center text-xs leading-relaxed">
                  選んだ経路はこのアカウントでは見つかりません。<br />経路を選び直してください。
                </p>
              ) : visualReferenceQr ? (
                <QrCode aria-label="友だち追加QRコード" className="text-ink" size={150} strokeWidth={3.8} />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- Worker のQRプロキシ。静的アセットではない */
                <img
                  src={qrDataUrl || qrSrc}
                  alt={direct?.title ?? resource?.title ??'友だち追加QRコード'}
                  width={220}
                  height={220}
                  className="aspect-square h-auto w-full max-w-[220px]"
                />
              )}
            </div>
            <p className="text-ink mt-3 text-sm font-medium">{accountName}</p>
            {profileUrl && (
              <a
                href={profileUrl}
                target="_blank"
                rel="noreferrer"
                className="text-action mt-1 max-w-full truncate text-xs hover:underline"
              >
                {profileUrl}
              </a>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            {direct?.content}
            {!direct && !resource ? <div>
              <label htmlFor="qr-route" className="text-ink-secondary mb-1 block text-xs font-medium">
                発行中の追加URL
              </label>
              <SaveErrorField names={["routeId","route_id"]}><EntitySelect
                aria-label="発行中の追加URL"
                size="full"
                id="qr-route"
                value={routeId}
                onChange={(value) => {
                  setRouteId(value)
                  onRouteIdChange?.(value)
                }}
                className="w-full"
                options={[
                  { value: '', label: '基本の追加URL' },
                  ...routes.filter((r) => r.isActive).map((r) => ({ ...entityOptionMetadata(r), value: r.id, label: r.name })),
                ]}
              /></SaveErrorField>
              {routeStopped ? (
                <p className="text-danger mt-1 text-xs" role="alert">
                  この経路は停止しています。QRコードと印刷は出せません。
                  {stoppedDetail ? ` ${stoppedDetail}` : '別の経路か「基本の追加URL」を選んでください。'}
                </p>
              ) : routesError || lookupState==='loading' ? null : routeMissing ? (
                <p className="text-danger mt-1 text-xs" role="alert">
                  選んだ経路はこのアカウントでは使えません。別の経路か「基本の追加URL」を選んでください。
                </p>
              ) : (
                <p className="text-ink-faint mt-1 text-xs">
                  選んだ経路のQRコードとURLが表示されます。
                </p>
              )}
            </div>:null}
            {!direct||direct.downloads?<><div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <label htmlFor="qr-size" className="text-ink-secondary mb-1 block text-xs font-medium">
                  画像の大きさ
                </label>
                <SaveErrorField names={["size"]}><Select
                  aria-label="画像の大きさ"
                  size="full"
                  id="qr-size"
                  value={size}
                  onChange={(value) => setSize(value)}
                  className="w-full"
                  options={sizes.map((s) => ({ value: s.value, label: s.label }))}
                /></SaveErrorField>
              </div>
              <div>
                <span className="text-ink-secondary mb-1 block text-xs font-medium">
                  ダウンロード形式
                </span>
                {/*
                  3形式は等幅のセグメントにする（DASH-19）。内容幅の flex だと
                  SVG 側だけ余白が偏り、未選択の余白が選択肢の一部に見えた。
                */}
                <SegmentedControl options={formats} value={format} onChange={setFormat} aria-label="画像形式" equalWidth />
              </div>
            </div>

            {resource?.paperSizes ? <Select aria-label="紙の大きさ" value={paper} onChange={v => setPaper(v as 'A4' | 'A5')} options={[{value:'A4',label:'A4'},{value:'A5',label:'A5'}]} /> : null}
            <div>
              <label
                htmlFor="qr-link"
                className="text-ink-secondary mb-1 block text-xs font-medium"
              >
                {direct?'来店スタンプのリンク':'友だち追加リンク'}
              </label>
              {/*
                コピー操作は入力欄の外の独立した列へ出す（DASH-20）。
                欄内の absolute 配置だと「コピーしました ✓」に変わったとき
                URL と重なり、狭い幅では右側が切れていた。狭い幅では下へ。
              */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <SaveErrorField names={["link"]}><SharedTextArea
                  id="qr-link"
                  readOnly
                  rows={3}
                  value={blocked ? '' : link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="border-hairline bg-canvas-sunken text-ink-secondary rounded-control min-w-0 flex-1 resize-none border px-3 py-2 font-mono text-xs leading-relaxed focus:outline-none"
                /></SaveErrorField>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={copy}
                  disabled={blocked}
                  title={blocked ? disabledReason : undefined}
                  className="shrink-0"
                >
                  コピー
                </Button>
              </div>
              {/*
                コピーの成否は読み上げにも通知する（DASH-29）。
                失敗時は欄から手動で選択してコピーできる案内を残す。
              */}
              <p aria-live="polite" className={`mt-1 text-xs ${copyState === 'failed' ? 'text-danger' : copyState === 'copied' ? 'text-success' : 'text-ink-faint'}`}>
                {copyState === 'failed'
                  ? 'コピーできませんでした。上のURLを選択してコピーしてください'
                  : copyState === 'copied'
                    ? 'コピーしました ✓'
                    : (direct?'このQRを読んだ本人に押印します。':'このURLから追加された友だちは、流入元を記録して計測できます。')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {resource?.downloadImage ? <Button variant="primary" disabled={blocked || pdfState === 'working'} title={blocked ? disabledReason : undefined} busy={imageState === 'working'} onClick={() => void downloadImage()}><DownloadIcon />{format.toUpperCase()} を保存</Button> : blocked ? (
                <Button variant="primary" disabled title={disabledReason}>
                  <DownloadIcon />画像をダウンロード
                </Button>
              ) : (
                <Button
                  href={saveHref}
                  variant="primary"
                >
                  <DownloadIcon />画像をダウンロード
                </Button>
              )}
              {/*
                印刷用PDFはサーバーで作る（M）。経路を選んでいるときは
                サーバーのPDFを取り寄せ、基本の追加URLのときだけ従来の
                ブラウザ印刷を使う。止めた経路では押せない。
              */}
              {resource?.downloadPdf || route && route.isActive ? (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void downloadPdf()}
                  disabled={blocked || pdfState === 'working' || imageState === 'working'}
                  title={blocked ? disabledReason : undefined}
                >
                  PDFで印刷
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={printQr}
                  disabled={blocked}
                  title={blocked ? disabledReason : undefined}
                >
                  PDFで印刷
                </Button>
              )}
            </div>
            {imageState === 'failed' ? <FieldError id="qr-save-error">QRを保存できませんでした。もう一度お試しください。</FieldError> : null}
            {pdfState === 'failed' ? (
              <p className="text-danger mt-1 text-xs" role="alert">
                印刷用PDFを作れませんでした。もう一度押してください。
              </p>
            ) : null}

            <div className="border-hairline bg-surface-pearl rounded-control border p-4">
              <h3 className="text-ink text-sm font-bold">使うときのヒント</h3>
              <ul className="text-ink-faint mt-2 space-y-1 text-xs leading-relaxed">
                <li>・印刷には「大（1024px）」を選んでください（小さいと読み取れないことがあります）</li>
                <li>{direct?'・店頭のQRは同じ日に1回までです':'・流入経路ごとにリンクを分けると、どこから来たかを計測できます'}</li>
                <li>・QRの周囲は余白を1cm以上あけてください</li>
              </ul>
            </div>
            </>:null}
            {direct?.footer}
          </div>
        </div>}
      </div>
    </div>
  )
}
