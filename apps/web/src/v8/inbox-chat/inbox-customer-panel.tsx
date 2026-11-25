'use client'
import { createPortal } from 'react-dom'
import Button from '@/components/shared/button';
import { InboxEmailHeading, InboxInfoBackdrop } from '@/components/shared/inbox-content';
import { InboxSummaryPane } from '@/components/templates/inbox-page';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { EmailInboxItem } from './inbox-model';

type Props = {
  lineContent: React.ReactNode
  showFriendInfo: boolean
  selectedChatId: string | null
  selectedThreadId: string | null
  wideInfoPanel: boolean
  setShowFriendInfo: (next: boolean | ((current: boolean) => boolean)) => void
  customerPanelRef: RefObject<HTMLElement | null>
  emailItems: EmailInboxItem[]
}

export default function InboxCustomerPanel({ lineContent, showFriendInfo, selectedChatId, selectedThreadId, wideInfoPanel, setShowFriendInfo, customerPanelRef, emailItems }: Props) {
  const [desktopOverlay, setDesktopOverlay] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const sync = () => setDesktopOverlay(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  const slotRef = useRef<HTMLDivElement>(null)
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.style.display = 'contents'
    return element
  })
  // 置き場だけを動かし、編集中の欄と購読を作り直さない。
  useLayoutEffect(() => {
    if (!host) return
    const target = wideInfoPanel ? slotRef.current : document.body
    if (!target || host.parentElement === target) return
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
      ? document.activeElement : null
    target.appendChild(host)
    focused?.focus({ preventScroll: true })
  }, [wideInfoPanel, host])
  useLayoutEffect(() => () => host?.remove(), [host])

  const content = (showFriendInfo && (selectedChatId || selectedThreadId) && (
    <>
      {/*
              1536px 未満ではトークの上に重ねるドロワー。背景（暗幕）を
              押しても閉じる。モバイルヘッダー(z-50)より上に置く。
              1536px 以上では右列として常設するので暗幕は CSS で消す。
            */}
      <InboxInfoBackdrop wide={wideInfoPanel || desktopOverlay} onMouseDown={() => setShowFriendInfo(false)} />
      <InboxSummaryPane wide={wideInfoPanel}
        ref={customerPanelRef}
        data-inbox-v4="customer-panel"
        role={wideInfoPanel ? undefined : desktopOverlay ? 'region' : 'dialog'}
        aria-modal={wideInfoPanel || desktopOverlay ? undefined : true}
        aria-label="顧客情報"
        tabIndex={-1}>
        {/*
              重なりの中にも閉じるボタンを置く。上部のボタンだけだと、
              重なりが上部を覆っている画面幅で閉じられなくなる。
              実際そうなっていた。
            */}
        {/*
              ★V8：右の列として出しているときは閉じる×を置かない。絵（M0393）の閉じる口は
              会話の頭の「顧客情報を表示（右の列の出し入れ）」の1つだけ。重ねて出す幅では
              頭が隠れるので、×を板の右上に残す。
            */}
        {wideInfoPanel ? null : (
          <Button
            variant="secondary"
            className="absolute top-3 right-3 z-10 h-8 w-8 items-center justify-center text-ink-faint whitespace-normal"
            type="button"
            onClick={() => setShowFriendInfo(false)}
            aria-label="顧客情報を閉じる"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        )}
        {selectedThreadId ? (
          /*
            メールの相手は友だちに結びついていない。
            以前は「紐づいていません」の1行だけで、なぜなのか・
            どうすればよいのかが分からなかった。誰との話かと、
            いま何ができるかを出す。
          */
          (() => {
            const mail = emailItems.find((e) => e.threadId === selectedThreadId)
            return (
              <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
                <InboxEmailHeading>
                  <p className="text-ink text-sm font-bold">顧客情報</p>
                  <p className="text-ink-faint mt-0.5 truncate text-micro">メールの相手を確認できます</p>
                </InboxEmailHeading>

                <div className="flex-1 overflow-y-auto divide-y divide-hairline">
                  <section className="flex flex-col items-center px-5 py-5 text-center">
                    <div className="bg-canvas-sunken border-hairline flex h-14 w-14 items-center justify-center rounded-pill border">
                      <span className="text-ink-secondary text-micro font-bold">MAIL</span>
                    </div>
                    <p className="text-ink mt-2 max-w-full truncate text-sm font-bold">{mail?.customerName ?? '—'}</p>
                    <p className="text-ink-faint mt-0.5 max-w-full break-all text-micro">
                      {mail?.customerIdentifier ?? 'メールアドレス未登録'}
                    </p>
                  </section>

                  <section className="px-5 py-4">
                    <p className="text-ink text-xs font-medium">基本情報</p>
                    <dl className="mt-2 space-y-2 text-xs">
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint shrink-0">名前</dt>
                        <dd className="text-ink-secondary min-w-0 truncate text-right">{mail?.customerName ?? '未登録'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint shrink-0">メール</dt>
                        <dd className="text-ink-secondary min-w-0 break-all text-right">{mail?.customerIdentifier ?? '未登録'}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="px-5 py-4">
                    <p className="text-ink text-xs font-medium">LINE友だちとの連携</p>
                    <p className="text-ink-faint mt-2 text-xs leading-relaxed">
                      このメールアドレスは、まだLINEの友だちと結びついていません。
                    </p>
                    <Link href="/friends" className="text-action mt-2 inline-flex text-xs font-semibold hover:underline">
                      友だち一覧で確認する
                    </Link>
                  </section>

                </div>
              </div>
            )
          })()
        ) : (
          <>{lineContent}</>
        )}
      </InboxSummaryPane>
    </>
  ))
  // 列は受信箱へ、重なる欄は画面直下へ置く。同じ置き場を使い続ける。
  return <>
    <div ref={slotRef} style={{ display: 'contents' }} />
    {host ? createPortal(content, host) : content}
  </>
}
