import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bucket = 'nen-line-stg-images'
const origin = 'https://stg-admin.musubo.jp'
const requiredHeaders = ['content-type', 'x-amz-meta-line-account-id', 'x-amz-meta-upload-session-id']

export function plannedCorsRules(rules) {
  if (!Array.isArray(rules) || rules.length !== 1) throw new Error('検証R2のCORSルール数が想定と違います。変更を止めます。')
  const rule = rules[0]
  const allowed = rule?.allowed
  const headers = (allowed?.headers ?? []).map((value) => value.toLowerCase())
  const exposes = (rule.exposeHeaders ?? []).map((value) => value.toLowerCase())
  if (!allowed?.methods?.includes('PUT') ||
      !allowed?.origins?.includes('https://nen-line-stg-admin.pages.dev') ||
      !requiredHeaders.every((value) => headers.includes(value)) ||
      !exposes.includes('etag')) {
    throw new Error('既存の署名PUT用CORS設定が想定と違います。変更を止めます。')
  }
  if (allowed.origins.includes('*')) throw new Error('全Origin許可のCORS設定は変更せず、調査します。')
  return [{ ...rule, allowed: { ...allowed, origins: [...new Set([...allowed.origins, origin])] } }]
}

async function cloudflare(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json()
  if (!response.ok || !payload.success) throw new Error(`Cloudflare R2 CORS ${method} failed (${response.status})`)
  return payload.result
}

async function verifyPreflight(accountId) {
  const url = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/media-upload-cors-probe`
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': requiredHeaders.join(','),
      },
    })
    if (response.status === 204 && response.headers.get('Access-Control-Allow-Origin') === origin) return
    if (attempt < 15) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error('Staging R2 PUT CORS preflight did not allow the current Admin origin')
}

async function main() {
  const mode = process.argv[2]
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error('mode must be dry-run or apply')
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || !token) throw new Error('Cloudflare account or token is missing')
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/cors`
  const before = await cloudflare('GET', endpoint, token)
  const rules = plannedCorsRules(before?.rules)
  const changed = JSON.stringify(before.rules) !== JSON.stringify(rules)
  console.log(`Staging R2 CORS: ${changed ? `add ${origin}` : `${origin} already present`}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### 検証R2 CORS\n\n- bucket: \`${bucket}\`\n- ${changed ? `追加予定: \`${origin}\`` : '設定済み'}\n- 変更前の完全な設定（復元用）:\n\n\`\`\`json\n${JSON.stringify(before, null, 2)}\n\`\`\`\n`)
  }
  if (mode === 'dry-run') return
  if (changed) {
    const backupPath = join(process.env.RUNNER_TEMP ?? '/tmp', `staging-r2-cors-before-${process.env.GITHUB_RUN_ID ?? 'local'}.json`)
    await writeFile(backupPath, JSON.stringify(before, null, 2))
    await cloudflare('PUT', endpoint, token, { rules })
    const after = await cloudflare('GET', endpoint, token)
    if (JSON.stringify(after?.rules) !== JSON.stringify(rules)) throw new Error('Cloudflare R2 CORS readback did not match the requested policy')
    console.log(`Staging R2 CORS updated and read back. Backup: ${backupPath}`)
  }
  await verifyPreflight(accountId)
  console.log('Staging R2 PUT preflight: allowed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
