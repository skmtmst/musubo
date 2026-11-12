'use client'

import TextLink from '@/components/shared/text-link'
import { useRouter } from 'next/navigation'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import AuthCard, { AuthField } from '@/components/auth/auth-card'
import Turnstile, { type TurnstileHandle } from '@/components/auth/turnstile'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Notice from '@/components/shared/notice'
import { TextField } from '@/components/shared/text-field'
import Select from '@/components/shared/select'
import { authRequest, CONTACT_URL, emailError, LEGAL_LINKS, readDeviceMarker, rememberSignupEmail, TURNSTILE_SITE_KEY } from '@/lib/auth-email'

const REFERRAL_OPTIONS = [
  { value: '', label: '選択してください' },
  ...['知人・取引先からの紹介', 'インターネット検索', 'SNS', '広告', 'イベント・セミナー', 'その他']
    .map((label) => ({ value: label, label })),
]

/** 利用申込。担当者の連絡と運営の承認後にだけ初期設定の案内を送る。 */
export default function RegisterPage() {
  const router = useRouter()
  const [companyName, setCompanyName] = useState('')
  const [contactName, setContactName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [referralSource, setReferralSource] = useState('')
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [agreed, setAgreed] = useState(false)
  const [agreeMessage, setAgreeMessage] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const turnstileRef = useRef<TurnstileHandle | null>(null)
  const setTurnstileHandle = useCallback((handle: TurnstileHandle | null) => {
    turnstileRef.current = handle
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const emailProblem = emailError(email)
    const next: Record<string, string> = {}
    if (!companyName.trim()) next.companyName = '会社名を入力してください'
    if (!contactName.trim()) next.contactName = '担当者名を入力してください'
    if (emailProblem) next.email = emailProblem
    if (!/^[+0-9()\- ]{9,24}$/.test(phone.trim()) || phone.replace(/\D/g, '').length < 9) next.phone = '電話番号を正しく入力してください'
    if (!referralSource) next.referralSource = 'musuboを知ったきっかけを選んでください'
    setMessages(next)
    setAgreeMessage(agreed ? null : '利用規約とプライバシーポリシーに同意してください')
    if (Object.keys(next).length || !agreed) return
    if (!turnstileToken) {
      setError('「私はロボットではありません」の確認を済ませてください')
      return
    }
    setBusy(true)
    setError('')
    const res = await authRequest<{ sent: boolean }>('/api/auth/register/request', {
      email: email.trim(),
      companyName: companyName.trim(),
      contactName: contactName.trim(),
      phone: phone.trim(),
      referralSource,
      agreed: true,
      turnstileToken,
      deviceMarker: readDeviceMarker(),
    })
    if (!res.ok) {
      setError(res.error || '送信できませんでした。時間をおいて、もう一度お試しください。')
      turnstileRef.current?.reset()
      setBusy(false)
      return
    }
    rememberSignupEmail(email.trim())
    router.replace('/register/sent')
  }

  return (
    <AuthCard
      node="Bo15C"
      applicationFlow="form"
      title="利用を申し込む"
      description="必要事項を送信すると、musuboの担当者からご連絡します。承認後に利用を開始できます。"
    >
      <div className="w-full rounded-control bg-accent-soft px-4 py-3 text-caption text-ink-secondary">
        <strong className="block text-ink">お申し込み後の流れ</strong>
        内容確認・担当者から連絡 → 承認 → アカウント作成 → 料金確認・カード登録 → LINE接続から無料期間開始
      </div>
      <form onSubmit={(event) => void submit(event)} noValidate className="flex w-full flex-col gap-4">
        {error ? (
          <Notice tone="danger" message={error} />
        ) : null}
        <AuthField label="会社名" htmlFor="register-company" error={messages.companyName}>
          <TextField id="register-company" value={companyName} onChange={(event) => setCompanyName(event.target.value)}
            autoComplete="organization" maxLength={80} placeholder="株式会社〇〇" invalid={Boolean(messages.companyName)} />
        </AuthField>
        <AuthField label="担当者名" htmlFor="register-contact" error={messages.contactName}>
          <TextField id="register-contact" value={contactName} onChange={(event) => setContactName(event.target.value)}
            autoComplete="name" maxLength={80} placeholder="見本 141" invalid={Boolean(messages.contactName)} />
        </AuthField>
        <AuthField label="メールアドレス" htmlFor="register-email" error={messages.email}>
          <TextField
            id="register-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={Boolean(messages.email)}
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            aria-describedby={messages.email ? 'register-email-error' : undefined}
          />
        </AuthField>
        <AuthField label="電話番号" htmlFor="register-phone" error={messages.phone}>
          <TextField id="register-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel" maxLength={24} placeholder="03-0000-5678" invalid={Boolean(messages.phone)} />
        </AuthField>
        <AuthField label="musuboを知ったきっかけ" htmlFor="register-referral" error={messages.referralSource}>
          <Select id="register-referral" aria-label="musuboを知ったきっかけ" size="full" value={referralSource} onChange={setReferralSource}
            options={REFERRAL_OPTIONS} invalid={Boolean(messages.referralSource)} />
        </AuthField>
        <p className="text-micro text-ink-faint">知人・取引先からの紹介／インターネット検索／SNS／広告／イベント・セミナー／その他</p>

        <Turnstile onToken={setTurnstileToken} handleRef={setTurnstileHandle} />

        <div className="flex flex-col gap-1.5">
          <Checkbox
            checked={agreed}
            onCheckedChange={setAgreed}
            invalid={Boolean(agreeMessage)}
          ><LegalWord href={LEGAL_LINKS.terms}>利用規約</LegalWord>と<LegalWord href={LEGAL_LINKS.privacy}>プライバシーポリシー</LegalWord>に同意します</Checkbox>
          {/*
            R169: 文書の公開先が未設定の間は、開けない文書への同意を説明なしに求めない。
            まだ公開されていないことと、確認の入口（お問い合わせはログイン不要）を添える。
          */}
          {!LEGAL_LINKS.terms || !LEGAL_LINKS.privacy ? (
            <p className="text-micro text-ink-faint">
              文書のページはまだ公開されていません。公開までの間、内容は{' '}
              <TextLink inline external href={CONTACT_URL}>
                お問い合わせ
              </TextLink> からご確認いただけます。
            </p>
          ) : null}
          {agreeMessage ? (
            <p role="alert" className="text-micro text-danger">
              {agreeMessage}
            </p>
          ) : null}
        </div>

        <Button type="submit" variant="primary" disabled={busy || !TURNSTILE_SITE_KEY} className="w-full" busy={busy} busyLabel="送っています…">申し込みを送信する
        </Button>
      </form>

      <p className="text-caption text-ink-faint">
        すでにアカウントをお持ちの方は{' '}
        <TextLink inline href="/login">
          ログイン
        </TextLink>
      </p>
    </AuthCard>
  )
}

function LegalWord({ href, children }: { href: string | null; children: string }) {
  if (!href) return <span className="font-semibold">{children}</span>
  return (
    <TextLink inline external href={href}>
      {children}
    </TextLink>
  )
}
