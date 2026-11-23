'use client'

import { useEffect, useState } from 'react'
import { Check, LoaderCircle, PanelsTopLeft } from 'lucide-react'
import { api, type HqLineRegistration } from '@/lib/api'
import { qrToDataURL } from '@/lib/qr-image'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import '@/components/shared/notice-line-tokens.css'
import styles from './notice-line-dialog.module.css'

const STATUS_INTERVAL_MS = 5000

/** 通知専用LINEの案内。Pen「musubo-notice-line-design-v01.pen」の未連携・連携済み・状態別UI。 */
export default function NoticeLineDialogV8({ open, onClose, quietWhenUnavailable = false, closeWhenLinked = false }: {
  open: boolean
  onClose: () => void
  /** 登録完了直後の自動表示では、運営側が未設定なら案内を出さずに閉じる。 */
  quietWhenUnavailable?: boolean
  /** LINEアカウント登録中は、通知連携を確認したら登録完了画面へ戻す。 */
  closeWhenLinked?: boolean
}) {
  const [info, setInfo] = useState<HqLineRegistration | null>(null)
  const [qr, setQr] = useState('')
  const [qrFailed, setQrFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [statusFailed, setStatusFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const linked = info?.available && info.linked
  const shouldClose = (closeWhenLinked && linked) || (quietWhenUnavailable && info && !info.available)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setInfo(null)
    setQr('')
    setQrFailed(false)
    setFailed(false)
    setStatusFailed(false)
    setNow(Date.now())
    void api.hqNotices.lineRegistration().then(async (res) => {
      if (cancelled) return
      if (!res.success) { setFailed(true); return }
      setInfo(res.data)
      if (res.data.available && !res.data.linked && !res.data.addFriendUrl) setQrFailed(true)
      if (res.data.available && !res.data.linked && res.data.addFriendUrl) {
        try {
          const image = await qrToDataURL(res.data.addFriendUrl, { width: 220, margin: 1 })
          if (!cancelled) setQr(image)
        } catch { if (!cancelled) setQrFailed(true) }
      }
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [open, attempt])

  useEffect(() => {
    if (open && shouldClose) onClose()
  }, [open, shouldClose, onClose])

  // 初回のプロフィール取得は繰り返さず、本人の紐づけ状態だけを照会する。
  useEffect(() => {
    if (!open || !info?.available || info.linked) return
    let cancelled = false
    let checking = false
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (checking) return
      checking = true
      void api.hqNotices.lineRegistrationStatus().then((res) => {
        if (cancelled) return
        if (!res.success) { setStatusFailed(true); return }
        setStatusFailed(false)
        if (res.data.linked) setInfo((current) => current?.available ? { ...current, linked: true, code: null, codeExpiresAt: null } : current)
      }).catch(() => { if (!cancelled) setStatusFailed(true) }).finally(() => { checking = false })
    }, STATUS_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [open, info?.available, info?.available && info.linked])

  if (!open || shouldClose) return null
  const expired = Boolean(info?.available && !linked && info.codeExpiresAt && now >= Date.parse(info.codeExpiresAt))
  const accountName = info?.available ? `${info.accountName}${info.basicId ? `（${info.basicId}）` : ''}` : ''

  return (
    <Dialog
      open={open}
      title={linked ? 'LINEとの連携が完了しています' : '運営からの通知をLINEで受け取る'}
      description={linked
        ? '契約先に関する大事なお知らせを、このLINEへお届けします。'
        : '契約先に関する料金・メンテナンスなどの重要なお知らせを、あなたのLINEへ届けます。'}
      headerIcon={<PanelsTopLeft />}
      designLayout="stacked"
      designWidth={560}
      designTop={120}
      onCancel={onClose}

    >
      {failed ? (
        <div className={styles.state} role="alert">
          <p>案内を読み込めませんでした。</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>もう一度読み込む</Button>
        </div>
      ) : !info ? (
        <p className={styles.state}><LoaderCircle className={styles.spinner} aria-hidden="true" />案内を読み込んでいます…</p>
      ) : !info.available ? (
        <p className={styles.state}>通知専用LINEはまだ運営側で設定されていません。設定できしだい、この画面からご案内します。</p>
      ) : linked ? (
        <div className={styles.body}>
          <div className={styles.statusLinked}><Check aria-hidden="true" />連携済み</div>
          <p className={styles.accountName}>{accountName}</p>
          <p className={styles.caveat}>このLINEは通知専用です。お問い合わせは各店舗アカウントの管理画面にある「お問い合わせ」からお送りください。</p>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.statusPending}><LoaderCircle className={styles.spinner} aria-hidden="true" />まだ連携していません ・ 2つの手順で登録できます</div>
          <div className={styles.registration}>
            <div className={styles.qrBox}>
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element -- 画面上で生成したQRのdata URL
                <img src={qr} alt={`${info.accountName} の友だち追加QRコード`} className={styles.qr} width={156} height={156} />
              ) : qrFailed ? <span className={styles.qrFallback}>QRを表示できません。<Button onClick={() => setAttempt((n) => n + 1)}>再読み込み</Button></span>
                : <LoaderCircle className={styles.spinner} aria-label="QRを準備しています" />}
            </div>
            <div className={styles.instructions}>
              <p className={styles.accountName}>{accountName}</p>
              <div className={styles.step}><span className={styles.stepNumber}>1</span><div><strong>LINEで友だち追加</strong><p>PC画面のQRをスマートフォンのLINEで読み取ります。</p></div></div>
              <div className={styles.step}><span className={styles.stepNumber}>2</span><div><strong>6桁コードをLINEのトークに送信</strong><p>あなたの管理画面とLINEを確認して紐づけます。</p></div></div>
              {expired ? (
                <div className={styles.codeExpired} role="status">確認コードの有効期限が切れました。<Button onClick={() => setAttempt((n) => n + 1)}>新しいコードを表示</Button></div>
              ) : info.code ? (
                <div className={styles.codeWrap}><span className={styles.codeLabel}>確認コード</span><p className={styles.code} aria-label={`確認コード ${info.code}`}>{info.code}</p><span className={styles.expiry}>24時間有効</span></div>
              ) : null}
            </div>
          </div>
          {statusFailed ? <div className={styles.statusError} role="status">連携状況を確認できません。自動で再確認します。</div> : null}
          <p className={styles.caveat}>このLINEは問い合わせを受け付けません。お問い合わせは各店舗アカウントの管理画面にある「お問い合わせ」からお送りください。</p>
        </div>
      )}
    </Dialog>
  )
}
