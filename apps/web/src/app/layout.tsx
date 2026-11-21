import type { Metadata } from 'next'
import { Inter, Noto_Sans_JP } from 'next/font/google'
import './globals.css'
import './polish.css'
import AppShell from '@/components/app-shell'
import DocumentTitleRoot from '@/components/shell/document-title'
import ClientErrorReporter from '@/components/client-error-reporter'
import ToastHost from '@/components/shared/toast'
import NameTipHost from '@/components/shared/name-tip'
import UnsavedHistoryRoot from '@/components/shared/unsaved-history-root'

const DEFAULT_TITLE = 'musubo LINE管理システム'

/*
 * 見た目は常に V8（2026-10-09 オーナー決定）。`<html data-theme="v8">` が
 * globals.css の `[data-theme="v8"]` の値を効かせる。環境変数・このブラウザに
 * 保存した選択・設定画面の切り替えはもう無い（最初の描画から v8。管理画面 が一瞬出ない）。
 */
/*
 * 管理画面の書体。英字と数字は Inter、かなと漢字は Noto Sans JP に見える
 * （文字のなめらか処理は既定のままにし、antialiased を付けない）
 * （--font-sans の並びが正本。Inter に日本語グリフが無いので、かなと漢字は
 * 自動で Noto Sans JP に落ちる）。
 *
 * next/font でビルド時にフォントを同梱するので、実行時に Google への
 * 通信は起きない。Noto Sans JP は unicode-range で分割されているため、
 * preload は欧文の Inter だけにする（全幅面の先読みは帯域の無駄）。
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const notoSansJp = Noto_Sans_JP({
  variable: '--font-noto-sans-jp',
  display: 'swap',
  preload: false,
})

export const metadata: Metadata = {
  description: DEFAULT_TITLE,
  icons: {
    icon: '/icon.svg',
  },
  // 管理画面は検索に出さない（public/robots.txt・_headers の X-Robots-Tag と同じ）。
  robots: { index: false, follow: false },
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_TITLE,
    type: 'website',
    locale: 'ja_JP',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja" data-theme="v8" className={`${inter.variable} ${notoSansJp.variable}`}>
      {/* 書体は globals.css の --font-sans が正本（#976 U080）。inline style はやめる。 */}
      <body className="bg-canvas-sunken text-ink font-sans">
        <UnsavedHistoryRoot />
        <ClientErrorReporter />
        <DocumentTitleRoot>
          <AppShell>{children}</AppShell>
        </DocumentTitleRoot>
        {/* 保存の知らせ（Toast）の置き場所。全画面で1つ。画面側は置かない。 */}
        <ToastHost />
        {/* アイコンだけのボタンの名前の吹き出し。全画面で1つ。画面側は置かない。 */}
        <NameTipHost />
      </body>
    </html>
  )
}
