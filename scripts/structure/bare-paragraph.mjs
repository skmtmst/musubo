import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const digest = (text) => createHash('sha256').update(text).digest('hex')

export function findBareParagraphs() {
  const result = []
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8')
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        function visit(node) {
          if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
            const opening = ts.isJsxElement(node) ? node.openingElement : node
            if (opening.tagName.getText(ast) === 'p' && !opening.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(ast) === 'className')) {
              result.push({ file: relative(root, path), line: ast.getLineAndCharacterOfPosition(opening.getStart(ast)).line + 1, fingerprint: digest(node.getText(ast)) })
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(ast)
      }
    }
  }
  for (const dir of ['apps/web/src/v8', 'apps/web/src/components']) scan(resolve(root, dir))
  return result
}

export function unexpectedParagraphs(found, baseline) {
  const remaining = new Map(baseline.map(item => [`${item.file}:${item.fingerprint}`, item.count]))
  return found.filter(item => {
    const key = `${item.file}:${item.fingerprint}`
    const count = remaining.get(key) || 0
    if (!count) return true
    remaining.set(key, count - 1)
    return false
  })
}
