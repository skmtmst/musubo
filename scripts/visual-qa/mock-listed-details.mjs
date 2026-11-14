export function listedFormResponse(method, pathname, rows, detail) {
  const id = /^\/api\/forms\/([^/]+)$/.exec(pathname)?.[1]
  if (method !== 'GET' || !id) return null
  const row = rows.find((item) => item.id === id)
  if (!row) return null
  return { success: true, data: { ...detail, id: row.id, name: row.name, description: row.description ?? detail.description } }
}

export function listedCommonVarResponse(method, pathname, rows, detail) {
  const id = /^\/api\/common-vars\/([^/]+)$/.exec(pathname)?.[1]
  if (method !== 'GET' || !id) return null
  const row = rows.find((item) => item.id === id)
  return row ? { success: true, data: { ...detail, ...row } } : null
}
