import { hqTemplatesApi, type HqTemplate, type Preflight, type Resolution, type DistributionResult } from '@/lib/hq-templates-api'

export interface FolderRun {
  template: HqTemplate
  accountIds: string[]
  preflight?: Preflight
  resolutions?: Resolution[]
  runId?: string
  result?: DistributionResult
}
export function assertTargets(preflight: Preflight, ids: string[]) {
  if (!ids.length || new Set(ids).size !== ids.length || preflight.stores.length !== ids.length ||
    new Set(preflight.stores.map((store) => store.accountId)).size !== ids.length || preflight.stores.some((store) => !ids.includes(store.accountId))) {
    throw new Error('配布先を確認できませんでした。もう一度アカウントを選択してください。')
  }
}
export function assertResult(run: FolderRun, result: DistributionResult) {
  if (result.runId !== run.runId || result.stores.length !== run.accountIds.length ||
    new Set(result.stores.map((store) => store.accountId)).size !== run.accountIds.length || result.stores.some((store) => !run.accountIds.includes(store.accountId))) {
    throw new Error('配布番号または配布先が一致しません。結果を再確認してください。')
  }
}
export const failedStatus = (status: DistributionResult['stores'][number]['status']) => ['failed', 'version_conflict', 'unsupported'].includes(status)
export const settledResult = (result?: DistributionResult) => Boolean(result && ['completed', 'partial', 'failed'].includes(result.status) && Array.isArray(result.stores) && result.stores.length > 0 && result.stores.every((store) => store && (store.status === 'succeeded' || failedStatus(store.status))))

/** ひな形を順に配る。POST前に番号を記録し、応答不明や実行中はGETだけで確認する。 */
export async function distributeFolder(runs: FolderRun[], update: (runs: FolderRun[]) => void) {
  const publish = () => update(runs.map((run) => ({ ...run })))
  for (const run of runs) {
    if (settledResult(run.result)) continue
    if (run.runId) {
      const recovered = await hqTemplatesApi.result(run.template.id, run.runId)
      assertResult(run, recovered); run.result = recovered; publish()
    } else {
      if (!run.preflight || !run.resolutions || !Number.isFinite(Date.parse(run.preflight.expiresAt)) || Date.parse(run.preflight.expiresAt) <= Date.now()) {
        throw new Error(`「${run.template.name}」の確認の有効期限が切れました。未配布分を再確認してください。`)
      }
      assertTargets(run.preflight, run.accountIds)
      run.runId = run.preflight.preflightId
      try { publish() } catch (error) { run.runId = undefined; throw error }
      try {
        const result = await hqTemplatesApi.distribute(run.template.id, run.runId, run.resolutions)
        assertResult(run, result); run.result = result; publish()
      } catch {
        const recovered = await hqTemplatesApi.result(run.template.id, run.runId)
        assertResult(run, recovered); run.result = recovered; publish()
      }
    }
    // 作成中を失敗として再送しない。次のひな形も結果が確定してから。
    if (!settledResult(run.result)) return
  }
}
export function folderResultRows(runs: FolderRun[]) {
  const rows = new Map<string, { template: HqTemplate; accountId: string; runId?: string; store?: DistributionResult['stores'][number] }>()
  for (const run of runs) for (const accountId of run.accountIds) {
    const key = `${run.template.id}:${accountId}`
    const stores = run.result?.stores
    const store = Array.isArray(stores) ? stores.find((item) => item && item.accountId === accountId) : undefined
    rows.set(key, { template: run.template, accountId, runId: run.runId, store })
  }
  return [...rows.values()]
}
