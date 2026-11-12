import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { hasExportedV8Component } from './v8-component-source.mjs'

const mutationMethod = /^(?:(?:create|update|save|register|upsert|replace|publish|connect|set|patch|edit)(?:$|[A-Z_])|(?:bulk|batch)(?:Create|Update|Save))/
// メニュー一覧の保管・再開には入力欄がない。名前や価格の編集は引き続き対象にする。
function isMenuStatusOnly(call) {
  if (call.expression.getText() !== 'restaurantTestApi.updateMenu' || call.arguments.length !== 3) return false
  const payload = call.arguments[2]
  if (!ts.isObjectLiteralExpression(payload) || payload.properties.length !== 2) return false
  const props = payload.properties
  if (!props.every(ts.isPropertyAssignment)) return false
  const status = props.find(prop => prop.name.getText() === 'status')
  return !!status && ts.isStringLiteral(status.initializer) && ['active', 'archived'].includes(status.initializer.text)
    && props.some(prop => prop.name.getText() === 'expectedVersion')
}
function hasMutation(node) {
  let found = false
  visit(node, (child) => {
    if (!ts.isCallExpression(child)) return
    if (isMenuStatusOnly(child)) return
    const expression = child.expression
    if (ts.isPropertyAccessExpression(expression) && /^(?:api|[A-Za-z]\w*Api)\./.test(expression.getText()) && mutationMethod.test(expression.name.text) && !/(?:Validation|Preview|Impact)$/.test(expression.name.text)) found = true
    if (/^(?:saveTemplateEdit|save\w*Draft|onSave|host\.save|host\.onSave)$/.test(expression.getText())) found = true
  })
  return found
}
function visit(node, fn) { fn(node); ts.forEachChild(node, (child) => visit(child, fn)) }
function isFunction(node) { return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) }
function functionName(node) { return node.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : '') }
function componentOf(node) {
  for (let parent = node.parent; parent; parent = parent.parent) if (isFunction(parent) && /^(?:[A-Z]|use[A-Z])/.test(functionName(parent))) return parent
  return null
}
function hasScope(component, root) {
  return /<SaveErrorScope\b|fields=\{|return\s*\{\s*saveErrors\b/.test(component.getText(root))
}
function isFieldlessConnectionAction(node, component, root) {
  const action = node.getText(root)
  const screen = component.getText(root)
  return /api(?:\.\w+)+\.connect\s*\(/.test(action)
    && !/<(?:input|textarea|select|TextField|TextArea|SelectField|Checkbox|RadioGroup)\b/.test(screen)
}

/** 保存するcatch自身を見る。importだけ・別のcatchで受けるだけでは合格しない。 */
export function auditFormSaveErrors(source, filename = 'screen.tsx') {
  const root = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const findings = []
  visit(root, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch'
      && hasMutation(node.expression.expression)) {
      const component = componentOf(node)
      const callback = node.arguments[0]
      if (component && callback) {
        const wired = /\.capture\s*\(|\.setServerErrors\s*\(/.test(callback.getText(root))
        if (!wired || !hasScope(component, root)) findings.push({ filename, component: functionName(component), line: root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1, reason: !wired ? '保存Promiseのcatchが欄の理由を受けていません' : '欄へ渡すスコープがありません' })
      }
    }
    if (!ts.isTryStatement(node) || !node.catchClause) return
    let saves = hasMutation(node.tryBlock)
    for (let parent = node.parent; !saves && parent; parent = parent.parent) {
      if (isFunction(parent)) { saves = /save|submit|persist|publish/i.test(functionName(parent)) && /await/.test(node.tryBlock.getText(root)); break }
    }
    if (!saves) return
    const component = componentOf(node)
    if (!component) return // 非画面のAPIヘルパーは呼び出し側へエラーを渡す。
    // LINE再接続は入力欄のない操作。失敗は通知で案内し、保存欄エラーの対象にしない。
    if (isFieldlessConnectionAction(node.tryBlock, component, root)) return
    const catchText = node.catchClause.getText(root)
    const wired = /\.capture\s*\(|\.setServerErrors\s*\(/.test(catchText)
    const scope = hasScope(component, root)
    if (!wired || !scope) findings.push({ filename, component: functionName(component), line: root.getLineAndCharacterOfPosition(node.catchClause.getStart(root)).line + 1, reason: !wired ? '欄の理由を受けず、上の知らせだけにしています' : '欄へ渡すスコープがありません' })
  })
  return findings
}

export function savedScreenFiles(root) {
  const sourceFiles = ['src/v8', 'src/app'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true }).map(file => path.join(dir, file)))
    .filter(file => file.endsWith('.tsx') && !/\.(?:test|spec)\.tsx$|fixture/.test(file))
  const selected = new Set()
  const parse = file => ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const pending = sourceFiles.filter(file => {
    if (file.startsWith('src/v8/') || file.endsWith('-v8.tsx') || file.includes('/v8/')) return true
    return hasExportedV8Component(parse(file))
  })
  while (pending.length) {
    const file = pending.pop()
    if (selected.has(file)) continue
    selected.add(file)
    for (const statement of parse(file).statements) {
      const runtimeExport = ts.isExportDeclaration(statement) && !statement.isTypeOnly && (!statement.exportClause || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(binding => !binding.isTypeOnly))
      if (!runtimeExport || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue
      const stem = path.resolve(root, path.dirname(file), statement.moduleSpecifier.text)
      const target = [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')].find(file => /\.tsx?$/.test(file) && fs.existsSync(file) && fs.statSync(file).isFile())
      if (target && !/\.(?:test|spec)\.|fixture/.test(target) && !path.relative(path.join(root, 'src'), target).startsWith('..')) pending.push(path.relative(root, target))
    }
  }
  return [...selected].sort()
}

export function auditSavedScreens(root) {
  return savedScreenFiles(root).flatMap((file) => auditFormSaveErrors(fs.readFileSync(path.join(root, file), 'utf8'), file))
}
