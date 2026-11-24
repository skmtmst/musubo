import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadUpdateClient() {
  vi.resetModules()
  return import('./update-client')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('update-client manifest URL', () => {
  it('always uses the Worker manifest proxy even when a public GitHub URL is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    vi.stubEnv(
      'NEXT_PUBLIC_MANIFEST_URL',
      'https://github.com/Shudesu/line-harness-oss/releases/latest/download/release-manifest.json',
    )

    const { getManifestUrl } = await loadUpdateClient()

    expect(getManifestUrl()).toBe('https://example-worker.workers.dev/admin/manifest')
  })

  it('fetches the manifest from the Worker proxy', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    const manifest = { schema_version: 1, latest: '0.14.1', releases: [] }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(manifest)))

    const { getManifest } = await loadUpdateClient()

    await expect(getManifest()).resolves.toEqual(manifest)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example-worker.workers.dev/admin/manifest',
      { cache: 'no-store' },
    )
  })

  it('shares only an in-flight manifest and retries after completion', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    let finish!: (response: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue(new Response('{"releases":[]}'))
    const { getManifest } = await loadUpdateClient()
    const a = getManifest(), b = getManifest()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish(new Response('{"releases":[]}'))
    const [first, second] = await Promise.all([a, b])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    await getManifest()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['account', 'login', 'permissions'] as const)('does not share an in-flight manifest after %s changes', async kind => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://example-worker.workers.dev')
    const values = new Map([['lh_csrf', 'session-a'], ['lh_selected_account', 'account-a']])
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null })
    let finish!: (response: Response) => void
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue(new Response('{"releases":[]}'))
    const { getManifest } = await loadUpdateClient()
    const old = getManifest()
    if (kind === 'account') values.set('lh_selected_account', 'account-b')
    if (kind === 'login') values.set('lh_csrf', 'session-b')
    if (kind === 'permissions') (await import('./api/transport/read-cache')).clearApiReadCache()
    const fresh = getManifest()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    finish(new Response('{"releases":[]}'))
    await Promise.all([old, fresh])
    vi.unstubAllGlobals()
  })
})
