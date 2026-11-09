import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTACT_URL, LEGAL_LINKS, PUBLIC_AUTH_PATHS } from '@/lib/auth-email'

const SRC = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/**
 * ログイン（0-1）・会員登録（36-4）・パスワード再設定（36-6）の見張り。
 * 動きの正本は `docs/hq-signup-and-password-login.md`、見た目の正本は Pencil ★V8（`docs/v8-design-rules.md`）。
 * 当時の下書き 管理画面-36 は本線に入らなかった（原本なし）。
 */
describe('ログイン前の画面（0-1／36-4／36-6）', () => {
  it('ログイン前に開ける画面はすべて page.tsx があり、shell と guard の両方が同じ一覧を見る', () => {
    for (const path of PUBLIC_AUTH_PATHS) {
      expect(existsSync(join(SRC, 'app', path, 'page.tsx')), `${path} の page.tsx`).toBe(true)
    }
    expect(read('components/app-shell.tsx')).toContain('isPublicAuthPath(pathname)')
    expect(read('components/auth-guard.tsx')).toContain('isPublicAuthPath(pathname)')
  })

  it('ログインはメール＋パスワードが主で、LINE ログインが副。登録と再設定への導線がある', () => {
    const login = read('app/login/page.tsx')
    expect(login).toContain("node=\"UufG8\"")
    expect(login).toContain('/api/auth/password/login')
    expect(login).toContain('/api/auth/line')
    expect(login).toContain('href="/register"')
    expect(login).toContain('href="/password/forgot"')
    expect(login).toContain('autoComplete="current-password"')
    // 認証後の画面とnonceの受け渡しは login-remember-setup-react.test.tsx で実操作する。
  })

  it('登録の 1 歩目は会社・担当者・連絡先・きっかけを送る。Turnstile と同意がある', () => {
    const page = read('app/register/page.tsx')
    expect(page).toContain("node=\"Bo15C\"")
    expect(page).toContain('/api/auth/register/request')
    expect(page).toContain('<Turnstile')
    expect(page).toContain('readDeviceMarker()')
    expect(page).toContain('agreed: true')
    expect(page).toContain('companyName: companyName.trim()')
    expect(page).toContain('contactName: contactName.trim()')
    expect(page).toContain('phone: phone.trim()')
    expect(page).toContain('referralSource')
    expect(page).not.toContain('autoComplete="new-password"')
    // 入れたメールは URL に載せない
    expect(page).toContain('rememberSignupEmail(')
    expect(page).not.toContain('?email=')
  })

  it('本登録は URL の token を確かめてから出し、終わったら印を残して統括の画面へ', () => {
    const page = read('app/register/complete/page.tsx')
    expect(page).toContain('/api/auth/register/check?token=')
    expect(page).toContain('/api/auth/register/complete')
    expect(page).toContain('storeDeviceMarker(')
    expect(page).toContain('autoComplete="new-password"')
  })

  it('再設定は Turnstile 付きで依頼し、URL の token で新しいパスワードを設定する', () => {
    const forgot = read('app/password/forgot/page.tsx')
    expect(forgot).toContain('<Turnstile')
    expect(forgot).toContain('/api/auth/password/forgot')
    const reset = read('app/password/reset/page.tsx')
    expect(reset).toContain('/api/auth/password/reset/check?token=')
    expect(reset).toContain('/api/auth/password/reset')
    expect(reset).toContain('autoComplete="new-password"')
  })

  it('Turnstile はサイト用の鍵が無いと枠を出さず、親のボタンも押せない', () => {
    const turnstile = read('components/auth/turnstile.tsx')
    expect(turnstile).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY')
    expect(turnstile).toContain('challenges.cloudflare.com/turnstile/v0/api.js')
    for (const p of ['app/register/page.tsx', 'app/password/forgot/page.tsx']) {
      expect(read(p)).toContain('disabled={busy || !TURNSTILE_SITE_KEY}')
    }
  })

  it('同意欄の規約リンクは、ページができるまで文字だけで出す（URL は環境変数）', () => {
    const lib = read('lib/auth-email.ts')
    expect(lib).toContain('NEXT_PUBLIC_TERMS_URL')
    expect(lib).toContain('NEXT_PUBLIC_PRIVACY_URL')
    expect(read('components/auth/auth-card.tsx')).toContain('if (!href) return <span>')
  })

  it('文書の公開先が未設定のときは、説明なしに同意だけを求めない（R169）', () => {
    const page = read('app/register/page.tsx')
    // 開けない文書への同意を求める代わりに、まだ公開されていないことと
    // ログイン不要の確認口（お問い合わせ）を添える。
    expect(page).toContain('!LEGAL_LINKS.terms || !LEGAL_LINKS.privacy')
    expect(page).toContain('文書のページはまだ公開されていません')
    expect(page).toContain('href={CONTACT_URL}')
  })

  it('ログイン前のお問い合わせはサービスサイトの /contact/ へ（監査 m18e）', () => {
    // /hq/support はログインが要り、未ログインではログイン画面へ戻される。
    // 新しい公開フォームは作らない。URL は環境変数で変えられる。
    const lib = read('lib/auth-email.ts')
    expect(lib).toContain('NEXT_PUBLIC_CONTACT_URL')
    expect(lib).toContain('/contact/')
    const card = read('components/auth/auth-card.tsx')
    expect(card).toContain('CONTACT_URL')
    expect(card).toContain('target="_blank"')
    expect(card).not.toContain('href="/hq/support"')
  })
})

describe('ログイン前のリンク先の既定（リリース前点検 2026-10-07）', () => {
  it('配備の変数が無くても、規約・方針・表記・お問い合わせは musubo.jp の公開ページへ向く', () => {
    // 変数の無い試験の環境で読む＝既定値。別事業（ペットフード店）の窓口へ落とさない。
    expect(LEGAL_LINKS.terms).toBe('https://musubo.jp/terms/')
    expect(LEGAL_LINKS.privacy).toBe('https://musubo.jp/privacy/')
    expect(LEGAL_LINKS.commerce).toBe('https://musubo.jp/legal/')
    expect(CONTACT_URL).toBe('https://musubo.jp/contact/')
    expect(read('lib/auth-email.ts')).not.toContain('nen-petfood.com')
  })
})
