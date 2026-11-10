'use client'

import type { ReactNode } from 'react'
import { useDocumentTitle } from '@/components/shell/document-title'
import { PageHeading } from '@/components/templates/page-frame'
import authStyles from '@/components/templates/auth-page.module.css'
import { CONTACT_URL, LEGAL_LINKS } from '@/lib/auth-email'
import MusuboLogo from '@/components/shared/musubo-logo'
import { Check, Clock3 } from 'lucide-react'
import applicationStyles from './application-auth.module.css'

/**
 * ログイン前の画面の入れ物。★管理画面 0-1／36-4／36-6 の「登録カード」（幅 520）。
 *
 * 地は `$canvas-parchment`（= `bg-shell` #f5f5f7）で、白いカード（角丸 18 = `rounded-large`）を真ん中に置く。
 * 公式ロゴ → 見出し → 説明 → 中身。フッターに規約などのリンク。
 * リンク先がまだ無いものは文字だけ出す（`LEGAL_LINKS`）。
 */
export default function AuthCard({
  title,
  description,
  children,
  node,
  cardNode,
  variant,
  titleId,
  authLayout,
  step,
  wide,
  applicationFlow,
}: {
  title: string
  description: ReactNode
  children: ReactNode
  /** Pencil の画面ノード。 */
  node?: string
  /** Pencil のカードノード。 */
  cardNode?: string
  variant?: 'totp'
  titleId?: string
  authLayout?: 'admin' | 'ops'
  /** ログインの何段目か（「2 / 2」）。カードの頭の右に出す。 */
  step?: { current: number; total: number }
  /** 中身が広いカード（二段階認証の設定）。 */
  wide?: boolean
  /** 申込承認フロー v01 のカード。既存のログイン画面には適用しない。 */
  applicationFlow?: 'form' | 'sent' | 'setup' | 'pending' | 'recovery'
}) {
  // ログイン前の画面もタブの題を「<見出し> | musubo」にする。
  useDocumentTitle(title)
  // V8 login confirmation/enrollment inherits its existing card tokens.
  if (variant === 'totp') return <main className={authStyles.page} data-auth-layout={authLayout}>
    <section className={authStyles.card} aria-label={title} data-auth-layout={authLayout} data-auth-width={wide ? 'wide' : undefined} data-design-node={cardNode}>
    <AuthCardHead step={step} />
    {/* 題 20/600 と説明 1 行を 1 組の見出しとして渡す。 */}
    <PageHeading
      title={title}
      titleAs="h1"
      titleId={titleId}
      inset="none"
      subtitle={authLayout === 'admin' ? description : undefined}
      subtitleSize="body"
      help={authLayout === 'admin' ? undefined : description}
    />
    {children}
  </section></main>

  const legal = (
    <footer className="flex flex-wrap items-center justify-center gap-4 text-micro text-ink-faint">
      <LegalLink href={LEGAL_LINKS.terms}>利用規約</LegalLink>
      <LegalLink href={LEGAL_LINKS.privacy}>プライバシーポリシー</LegalLink>
      <LegalLink href={LEGAL_LINKS.commerce}>特定商取引法に基づく表記</LegalLink>
      {/*
        ログインしていない人のお問い合わせは、サービスサイトの /contact/ へ。
        /hq/support はログインが要り、ログイン画面へ戻されてしまう（監査 m18e）。
      */}
      <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="hover:underline">
        お問い合わせ
      </a>
    </footer>
  )

  if (applicationFlow) return <main data-design-node={node} className={applicationStyles.page} data-flow={applicationFlow}>
    <section data-design-node={cardNode} className={applicationStyles.card} data-flow={applicationFlow} aria-label={title}>
      <MusuboLogo />
      {applicationFlow === 'sent' ? <div className={applicationStyles.stateIcon} data-tone="success"><Check aria-hidden="true" /></div> : null}
      {applicationFlow === 'pending' ? <div className={applicationStyles.stateIcon} data-tone="warning"><Clock3 aria-hidden="true" /></div> : null}
      <header className={applicationStyles.heading}><h1>{title}</h1><p>{description}</p></header>
      <div className={applicationStyles.body}>{children}</div>
    </section>
    {applicationFlow === 'form' ? <div className={applicationStyles.legal}>{legal}</div> : <footer className={applicationStyles.simpleFooter}><span>musubo</span><a href={CONTACT_URL} target="_blank" rel="noreferrer">お問い合わせ</a></footer>}
  </main>

  // ログインの 1 段目：二段階認証（2 段目）と同じ地・同じ幅・同じカード（枠の線なしで影だけ）。
  if (step) return (
    <main data-design-node={node} className={authStyles.page} data-auth-layout="admin" data-auth-foot="">
      <section data-design-node={cardNode} className={authStyles.card} aria-label={title} data-auth-layout="admin">
        <AuthCardHead step={step} />
        <PageHeading title={title} titleAs="h1" titleId={titleId} inset="none" subtitle={description} subtitleSize="body" />
        {children}
      </section>
      {legal}
    </main>
  )

  return (
    <main data-design-node={node} className="flex min-h-svh flex-col items-center justify-center bg-shell px-4 py-8 sm:px-6">
      <section
        data-design-node={cardNode}
        className="flex w-full max-w-130 flex-col items-center gap-5 rounded-large border border-hairline bg-canvas px-6 py-9 shadow-float sm:px-10"
      >
        <MusuboLogo />
        <div className="flex w-full flex-col items-center gap-2 text-center">
          <h1 className="text-heading font-bold text-ink">{title}</h1>
          <p className="text-caption text-balance text-ink-faint">{description}</p>
        </div>
        {children}
      </section>
      <div className="mt-6">{legal}</div>
    </main>
  )
}

/** 認証のカードでは店舗名を出さず、公式ロゴと手順だけを表示する。 */
function AuthCardHead({ step }: { step?: { current: number; total: number } }) {
  return <div className={authStyles.head} data-auth-head="">
    <MusuboLogo />
    {step ? <span className={authStyles.headStep}><span className="sr-only">ログインの手順 </span>{step.current} / {step.total}</span> : null}
  </div>
}

function LegalLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
      {children}
    </a>
  )
}

/** 項目のラベル行＋入力欄＋赤字。設計の「項目」（ラベル・補足・入力・エラー文）。 */
export function AuthField({
  label,
  hint,
  error,
  htmlFor,
  action,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  htmlFor: string
  /** ラベルの行の右端に置く小さな導線（パスワードを忘れた方など）。 */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      {/*
        U100: ラベルと補足を同じ行に並べると、320pxや200%拡大で
        補足が幅を取ってラベルが途中で折れる（「メールアド／レス」）。
        縦に積めば、ラベル→補足→入力→エラーの順でそのまま読める。
      */}
      <div className="flex w-full items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-label font-medium text-ink">
          {label}
        </label>
        {action ? <span className="shrink-0 text-label">{action}</span> : null}
      </div>
      {hint ? <p className="text-micro text-ink-faint">{hint}</p> : null}
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-micro text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
