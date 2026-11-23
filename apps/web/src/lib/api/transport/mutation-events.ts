export const API_MUTATION_SUCCEEDED = 'lh:api-mutation-succeeded'

export function announceApiMutation(path: string, accountId: string | null, accountIds?: string[]): void {
  if (typeof window === 'undefined') return
  try {
    const pathname = new URL(path, 'https://localhost').pathname
    if (pathname === '/api/getting-started/guide' || /\/(preview|validate)$/.test(pathname)) return
    window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId, accountIds } }))
  } catch {
    return
  }
}
