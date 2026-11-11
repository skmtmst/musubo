import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: null, selectedAccount: null }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/booking-menus/lib/edit-permission', () => ({ useBookingEdit: () => false }))
import { readUiSource } from '../../scripts/test-ui-source.mjs'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(SRC, 'app')

const CURRENT_ROUTES = ["/hq/billing", "/hq/open", "/hq/members", "/", "/chats", "/friends", "/tags", "/templates", "/scenarios", "/reminders", "/booking/bookings", "/booking/bookings/detail", "/booking/staff", "/inflow-links", "/inflow-links/new", "/inflow-links/detail", "/broadcasts/new", "/templates/detail", "/templates/edit", "/templates/carousel", "/rich-menus", "/rich-menus/edit", "/rich-menus/new", "/webinars", "/staff/new", "/settings", "/tags/new", "/tags/fields/new", "/tags/fields/migrate", "/nen-members", "/ec-commerce", "/login", "/friends/detail", "/accounts/new", "/register", "/register/sent", "/register/complete", "/password/forgot", "/password/reset"] as const
function entryFile(route: string) { return join(APP, route, 'page.tsx') }
function readWithParts(route: string) { return readUiSource(entryFile(route), 'utf8') }
function entryBody(route: string) {
  const file = entryFile(route)
  const source = readFileSync(file, 'utf8')
  const forwarded = source.match(/export \{ default \} from ['"](@\/v8\/[^'"]+)['"]/)?.[1]
  return forwarded ? readFileSync(join(SRC, `${forwarded.slice(2)}.tsx`), 'utf8') : source
}
function renderedImports(source: string) {
  const parsed = ts.createSourceFile('current.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = new Set<string>()
  const rendered = new Set<string>()
  function walk(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.name) imports.add(clause.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const spec of clause.namedBindings.elements) if (!spec.isTypeOnly) imports.add(spec.name.text)
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) rendered.add(node.tagName.getText(parsed))
    ts.forEachChild(node, walk)
  }
  walk(parsed)
  return [...rendered].filter((name) => imports.has(name) && name !== 'Suspense')
}

describe('current page entries and V8 components', () => {
  it('current routes are registered', () => {
    expect(CURRENT_ROUTES.length).toBeGreaterThan(0)
    expect(new Set(CURRENT_ROUTES).size).toBe(CURRENT_ROUTES.length)
  })
  it.each(['/booking/menus', '/booking/menus/new', '/booking/menus/staff'])('%s のV8本体は共通の型を使う', async (route) => {
    const screenModule = route === '/booking/menus' ? await import('@/v8/booking-menus/settings')
      : route === '/booking/menus/new' ? await import('@/v8/booking-menus/menu-form')
        : await import('@/v8/booking-menus/assign')
    const html = renderToStaticMarkup(createElement(screenModule.default as import('react').ComponentType<{ accountId: null }>, { accountId: null }))
    expect(html).toContain('data-page-template="create"')
    expect(html).toContain('data-template-region="content"')
  });

  it.each([
    ['/broadcasts/new', '<BroadcastForm'],
    // 2026-10-06：一覧は src/v8/forms/list に一から書いた。板の印は型（ListPage）の boardId で付ける。
    ['/form-submissions', "boardId={narrow ? 'GrnO4' : 'I3L41O'}"],
  ])('%s はV8の画面を読み込む', (route, marker) => {
    expect(readWithParts(route)).toContain(marker);
  });


  it.each(CURRENT_ROUTES)('%s has a current entry without a theme chooser', (route) => {
    const source = readFileSync(entryFile(route), 'utf8')
    expect(source).toMatch(/export default|export \{ default \}/)
    expect(source).not.toContain('useAdminTheme')
    expect(source).not.toMatch(/NEXT_PUBLIC_ADMIN_THEME|lh-admin-theme|v7:/)
  })
  it.each(CURRENT_ROUTES)('%s connects its rendered component', (route) => {
    expect(renderedImports(entryBody(route)).length).toBeGreaterThan(0)
    expect(readWithParts(route)).not.toMatch(/from ['"][^'"]*-v7['"]|VariantContext/)
  })
})
