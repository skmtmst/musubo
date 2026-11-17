/** Compare newly introduced source assertions with the PR base.
 * This is a conservative, bounded AST interpreter, never an executor of tests.
 */
import ts from 'typescript'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const digest = source => createHash('sha256').update(source).digest('hex').slice(0, 16)
// Keep every large domain's identity, without enumerating cartesian products.
// A new opaque source comparison still fails; this is not an exemption.
const atoms = strings => {
  const unique=[...new Set(strings.map(s=>s.length>2048?'#text:'+digest(s):s))]
  return unique.length>128?[...unique.slice(0,128),'#set:'+digest(JSON.stringify(unique))]:unique
}
const combine = (left,right,suffix='') => left.length*right.length>128
  ? atoms([...left.slice(0,8).flatMap(a=>right.slice(0,8).map(b=>a+b+suffix)),'#join:'+digest(JSON.stringify([left,right,suffix]))])
  : atoms(left.flatMap(a=>right.map(b=>a+b+suffix)))
const value = (fields = {}) => ({ strings: [], reads: [], ...fields })
const union = values => values.length === 1 ? values[0] : value({
  strings: atoms(values.flatMap(v => v?.strings ?? [])),
  reads: [...new Set(values.flatMap(v => v?.reads ?? []))],
  astReads: [...new Set(values.flatMap(v => v?.astReads ?? []))],
  reader: values.some(v => v?.reader),
  helper: [...new Set(values.map(v => v?.helper).filter(Boolean))].sort().join(','),
  functions: values.flatMap(v => v?.fn ? [v] : v?.functions ?? []),
})
const fingerprint = (node, readers) => {
  if (!node) return ''
  if(readers?.has(node))return ['source-reader',readers.get(node)]
  if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isIdentifier(node) || ts.isNumericLiteral(node)) return [node.kind, node.text]
  return [node.kind, ...node.getChildren().map(child=>fingerprint(child,readers))]
}
const canonical = (node, readers) => JSON.stringify(fingerprint(node,readers))
const target = path => /\.(?:[cm]?[jt]sx?|css|html|svg)(?:$|[?#])/.test(path)
const data = path => /\.(?:jsonc?|sql|csv|tsv|md|ya?ml|toml|snap|png|jpe?g|webp|gif|ico|woff2?|pdf)(?:$|[?#])/.test(path)
const harness = /^(?:describe|it|test)$/
const transforms = new Set(['trim','trimStart','trimEnd','slice','substring','substr','split','replace','replaceAll','match','matchAll','concat','join','toString','toLowerCase','toUpperCase'])
const execution = new Set(['render','renderToString','renderToStaticMarkup','setContent','addStyleTag','addScriptTag','writeFileSync','writeFile','exec','prepare','compile'])

class Scope {
  constructor(parent = null) { this.parent = parent; this.bindings = new Map(); this.hooks=[]; this.hookNodes=new Set() }
  get(name) { return this.bindings.get(name) ?? this.parent?.get(name) ?? (['Map','Set','Object','Math','JSON'].includes(name) ? value({intrinsic:name}) : value()) }
  set(name, result) { this.bindings.set(name, result) }
  assign(name, result) { if(this.bindings.has(name)||!this.parent)this.set(name,result);else this.parent.assign(name,result) }
}

export function analyzeSourceTests(files, entries = [...files.keys()].filter(isTest), statementBudget = 500000) {
  if (!Number.isSafeInteger(statementBudget) || statementBudget < 1 || statementBudget > 500000) throw Error('Invalid AST statement budget')
  const modules = new Map(), findings = [], active = new Set()
  const sourceCalls = new WeakMap(), fixtureWrites = new Map(), mockedReaders = new Map()
  const readers=new Set(),imports=new Map()
  let steps = 0
  const bind = (name, result, scope) => {
    if (ts.isIdentifier(name)) scope.set(name.text, result)
    else if (ts.isArrayBindingPattern(name)) name.elements.forEach((part, i) => { if (ts.isBindingElement(part)) bind(part.name, result.items?.[i] ?? union(result.items ?? [result]), scope) })
    else if (ts.isObjectBindingPattern(name)) name.elements.forEach(part => bind(part.name, result.props?.get(part.propertyName?.text ?? part.name.text) ?? value(), scope))
  }
  const modulePath = (from, specifier) => {
    const prefix = specifier.startsWith('@/') ? 'apps/web/src/' + specifier.slice(2)
      : specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), specifier)) : ''
    return [prefix, prefix.replace(/\.js$/, '.ts'), prefix.replace(/\.js$/, '.tsx'), prefix+'.ts', prefix+'.tsx', prefix+'.mjs', prefix+'/index.ts'].find(path => files.has(path))
  }
  for(const [file,source]of files){
    if(/['"](?:node:)?(?:fs(?:\/promises)?|child_process)['"]|readUiSource|\?raw/.test(source))readers.add(file)
    imports.set(file,ts.preProcessFile(source,true,true).importedFiles.map(item=>modulePath(file,item.fileName)).filter(Boolean))
  }
  let added=true
  while(added){added=false;for(const [file,dependencies]of imports)if(!readers.has(file)&&dependencies.some(path=>readers.has(path))){readers.add(file);added=true}}
  const fsModule = () => {
    const reader = name => value({ reader: true, readerName: name })
    return value({ props: new Map([['readFileSync',reader('readFileSync')],['readFile',reader('readFile')],['realpathSync',value({pathIdentity:true})],...['existsSync','accessSync','statSync','lstatSync','access','stat','lstat'].map(name=>[name,value({fileInfo:true})]),['promises',value({props:new Map([['readFile',reader('readFile')]])})]]) })
  }
  const emit = (ctx, node, actual, expected, reason) => {
    if (!actual.reads.length) return
    const position = ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf))
    const hit = { file: ctx.file, entry: ctx.entry ?? ctx.file, line: position.line+1, test: ctx.test || '(module)', reads: [...actual.reads].sort(), expression: node.getText(ctx.sf), expected: [...expected.strings].sort(), reason, tableRows: ctx.tableRows }
    hit.key = JSON.stringify([hit.entry,hit.file,hit.test,hit.reads,canonical(node,sourceCalls),hit.expected,reason])
    findings.push(hit)
  }
  const read = (path, ctx, node, helper = '') => {
    const paths = path.strings.filter(p => !p.startsWith('__fixture__/') && (target(p) || !data(p)))
    const fixtures=path.strings.filter(path=>path.startsWith('__fixture__/')).map(path=>fixtureWrites.get(path)??value())
    return union([value({ reads: paths.length ? paths.map(p => `${posix.normalize(p)}${helper ? '|helper:'+helper : ''}`) : path.strings.length ? [] : [`unknown:${ctx.file}:${canonical(node)}${helper ? '|helper:'+helper : ''}`] }),...fixtures])
  }
  const matcher = (name, negated, actual, expected, ctx, node) => {
    if (!actual.reads.length) return
    let presence = !negated
    if (actual.readLength && expected.strings.includes('0') && /^(?:toBe|toEqual|strictEqual|equal|toBeLessThanOrEqual)$/.test(name)) presence = negated
    else if (actual.collection && (!expected.items?.length && expected.items || expected.strings.includes('0') && /Length/.test(name))) presence = negated
    else if (actual.predicate) {
      let wantsTrue = !negated
      if (['toBe','toEqual','strictEqual','equal'].includes(name) && expected.bool !== undefined) wantsTrue = negated ? !expected.bool : expected.bool
      if (/Falsy|Null|Undefined/.test(name)) wantsTrue = negated
      presence = actual.predicate.sign === (wantsTrue ? 1 : -1)
    } else if (actual.index) {
      if (expected.strings.includes('-1') && /^(?:toBe|toEqual|equal|strictEqual)$/.test(name)) presence = negated
      else if (expected.strings.includes('0') && /LessThan/.test(name)) presence = negated
    }
    if (presence) emit(ctx,node,actual,expected,'positive-source-assertion')
  }
  const statements = (nodes, scope, ctx, depth) => {
    const returns = []
    for (const node of nodes) {
      if (++steps > statementBudget) throw Error(`AST analysis exceeded its bound: ${ctx.file}`)
      if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) bind(decl.name, evaluate(decl.initializer,scope,ctx,depth),scope)
      else if (ts.isFunctionDeclaration(node) && node.name) scope.set(node.name.text,value({ fn: node, scope, ctx }))
      else if (ts.isClassDeclaration(node) && node.name) scope.set(node.name.text,value({classNode:node,scope,ctx}))
      else if (ts.isExpressionStatement(node)) evaluate(node.expression,scope,ctx,depth)
      else if (ts.isReturnStatement(node)) returns.push(evaluate(node.expression,scope,ctx,depth))
      else if (ts.isBlock(node)) returns.push(statements(node.statements,new Scope(scope),ctx,depth))
      else if (ts.isIfStatement(node)) {
        const conditionText=node.expression.getText(ctx.sf)
        if(!ctx.test&&!isTest(ctx.file)&&/import\.meta\.(?:url|main)/.test(conditionText)&&/process\.argv|import\.meta\.main/.test(conditionText))continue
        const condition = evaluate(node.expression,scope,ctx,depth)
        const throws = branch => branch && (ts.isThrowStatement(branch) || ts.isBlock(branch) && branch.statements.some(ts.isThrowStatement))
        if (condition.predicate && throws(node.thenStatement)) matcher('toBe',false,condition,value({bool:false}),ctx,node.expression)
        if (condition.predicate && throws(node.elseStatement)) matcher('toBe',false,condition,value({bool:true}),ctx,node.expression)
        const assigned=new Set()
        const collect=part=>{if(ts.isBinaryExpression(part)&&part.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(part.left))assigned.add(part.left.text);ts.forEachChild(part,collect)}
        collect(node)
        const prior=new Map([...assigned].map(name=>[name,scope.get(name)]))
        returns.push(statements([node.thenStatement],new Scope(scope),ctx,depth))
        const then=new Map([...assigned].map(name=>[name,scope.get(name)]))
        for(const [name,result]of prior)scope.assign(name,result)
        if (node.elseStatement) returns.push(statements([node.elseStatement],new Scope(scope),ctx,depth))
        for(const [name,result]of then)scope.assign(name,union([result,scope.get(name)]))
      } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        const child = new Scope(scope), values = evaluate(node.expression,scope,ctx,depth)
        const decl = node.initializer.declarations?.[0]
        if (decl) bind(decl.name,union(values.items ?? [values]),child)
        returns.push(statements([node.statement],child,ctx,depth))
      } else if (ts.isTryStatement(node)) {
        returns.push(statements(node.tryBlock.statements,new Scope(scope),ctx,depth))
        if (node.catchClause) returns.push(statements(node.catchClause.block.statements,new Scope(scope),ctx,depth))
        if (node.finallyBlock) returns.push(statements(node.finallyBlock.statements,new Scope(scope),ctx,depth))
      }
    }
    return union(returns)
  }
  const invoke = (fn, args, caller, node, depth) => {
    if (!fn.fn || depth > 12 || active.has(fn.fn)) return union(args)
    active.add(fn.fn)
    const scope = new Scope(fn.scope), ctx = {...fn.ctx, entry:caller.entry??caller.file, test:caller.test, tableRows:caller.tableRows}
    fn.fn.parameters?.forEach((param,i) => bind(param.name,param.dotDotDotToken?value({items:args.slice(i),collection:true}):(!args[i]||args[i].undefined)?evaluate(param.initializer,scope,ctx,depth+1):args[i],scope))
    const result = ts.isBlock(fn.fn.body) ? statements(fn.fn.body.statements,scope,ctx,depth+1) : evaluate(fn.fn.body,scope,ctx,depth+1)
    active.delete(fn.fn)
    return result
  }
  const evaluate = (node,scope,ctx,depth=0) => {
    if (!node) return value({undefined:true})
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node)) return value({strings:atoms([node.text])})
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return value({bool:node.kind===ts.SyntaxKind.TrueKeyword})
    if (ts.isIdentifier(node)) return node.text==='undefined'?value({undefined:true}):scope.get(node.text)
    if(node.kind===ts.SyntaxKind.ThisKeyword)return scope.get('this')
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return evaluate(node.expression,scope,ctx,depth)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return value({fn:node,scope,ctx})
    if (ts.isArrayLiteralExpression(node)) {const items=node.elements.flatMap(el=>{const item=evaluate(ts.isSpreadElement(el)?el.expression:el,scope,ctx,depth);return ts.isSpreadElement(el)?item.items??[item]:[item]});return {...union(items),items,collection:true}}
    if (ts.isObjectLiteralExpression(node)) {const props=new Map();for(const property of node.properties){if(ts.isPropertyAssignment(property))props.set(property.name.text,evaluate(property.initializer,scope,ctx,depth));else if(ts.isShorthandPropertyAssignment(property))props.set(property.name.text,scope.get(property.name.text));}return value({props})}
    if (ts.isPropertyAccessExpression(node)) {
      const receiver=evaluate(node.expression,scope,ctx,depth)
      if (receiver.props) {
        const member=receiver.props.get(node.name.text)??value({undefined:true})
        return member.getter?invoke(member,[],ctx,node,depth):member
      }
      if(receiver.localModule)return value({localModule:receiver.localModule,exportName:node.name.text})
      if(receiver.astReads?.length)return node.name.text==='text'&&receiver.astRoot?value({reads:receiver.astReads}):value({astReads:receiver.astReads})
      if(ts.isMetaProperty(node.expression)&&node.name.text==='url')return value({strings:[ctx.file]})
      if(ts.isMetaProperty(node.expression)&&node.name.text==='dirname')return value({strings:[posix.dirname(ctx.file)]})
      if (node.name.text==='length') return value({strings:receiver.items?[String(receiver.items.length)]:[],reads:receiver.reads,readLength:receiver.collection})
      return receiver
    }
    if (ts.isElementAccessExpression(node)) {
      const receiver=evaluate(node.expression,scope,ctx,depth), key=evaluate(node.argumentExpression,scope,ctx,depth)
      return receiver.props?.get(key.strings[0]) ?? receiver.items?.[Number(key.strings[0])] ?? receiver
    }
    if (ts.isConditionalExpression(node)) {
      const condition=evaluate(node.condition,scope,ctx,depth)
      if(condition.undefined||condition.bool===false)return evaluate(node.whenFalse,scope,ctx,depth)
      if(condition.bool===true)return evaluate(node.whenTrue,scope,ctx,depth)
      return union([evaluate(node.whenTrue,scope,ctx,depth),evaluate(node.whenFalse,scope,ctx,depth)])
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operand=evaluate(node.operand,scope,ctx,depth)
      if(node.operator===ts.SyntaxKind.ExclamationToken)return {...operand,predicate:operand.predicate?{sign:-operand.predicate.sign}:{sign:-1}}
      if(node.operator===ts.SyntaxKind.MinusToken)return {...operand,strings:operand.strings.map(s=>'-'+s)}
      return operand
    }
    if (ts.isTemplateExpression(node)) {
      let result=value({strings:[node.head.text]})
      for(const span of node.templateSpans){const part=evaluate(span.expression,scope,ctx,depth);result={...union([result,part]),strings:combine(result.strings,part.strings,span.literal.text)}}
      return result
    }
    if (ts.isBinaryExpression(node)) {
      const left=evaluate(node.left,scope,ctx,depth),right=evaluate(node.right,scope,ctx,depth),op=node.operatorToken.kind
      if(left.undefined&&op===ts.SyntaxKind.AmpersandAmpersandToken)return left
      if(left.undefined&&[ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.BarBarToken].includes(op))return right
      if(op===ts.SyntaxKind.EqualsToken){if(ts.isIdentifier(node.left))scope.assign(node.left.text,right);else if(ts.isPropertyAccessExpression(node.left))evaluate(node.left.expression,scope,ctx,depth).props?.set(node.left.name.text,right);else bind(node.left,right,scope);return right}
      if(op===ts.SyntaxKind.PlusToken)return {...union([left,right]),strings:combine(left.strings,right.strings)}
      const result=union([left,right])
      if([ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken].includes(op)&&left.predicate&&right.bool!==undefined){result.predicate={sign:left.predicate.sign*(right.bool?1:-1)*([ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(op)?-1:1)}}
      else if(result.reads.length)result.predicate={sign:1}
      return result
    }
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return value()
    const call=node.expression,syntacticName=ts.isPropertyAccessExpression(call)?call.name.text:ts.isIdentifier(call)?call.text:''
    // import() executes a module; it does not return its source text.
    if(call.kind===ts.SyntaxKind.ImportKeyword){
      const specifier=evaluate(node.arguments?.[0],scope,ctx,depth)
      return specifier.strings.some(path=>path.includes('?raw'))?value({props:new Map([['default',read(specifier,ctx,node)]])}):value()
    }
    const name=(ts.isIdentifier(call)?scope.get(call.text).pathOp:undefined)??syntacticName
    const args=(node.arguments??[]).flatMap(arg=>ts.isSpreadElement(arg)?evaluate(arg.expression,scope,ctx,depth).items??[evaluate(arg.expression,scope,ctx,depth)]:[evaluate(arg,scope,ctx,depth)])
    if(['beforeEach','beforeAll'].includes(name)){
      for(const fn of args.filter(arg=>arg.fn))if(!scope.hookNodes.has(fn.fn)){scope.hookNodes.add(fn.fn);scope.hooks.push(fn)}
      return value()
    }
    if(['afterEach','afterAll'].includes(name))return value()
    // Interpret the test harness, not its imported runtime.
    let harnessCall=call
    while(ts.isPropertyAccessExpression(harnessCall)||ts.isCallExpression(harnessCall))harnessCall=harnessCall.expression
    if(ts.isIdentifier(harnessCall)&&harness.test(harnessCall.text)){
      const label=args[0]?.strings.join('|')||canonical(node.arguments?.[0]),next={...ctx,test:[ctx.test,label].filter(Boolean).join(' / ')}
      const rows=ts.isCallExpression(call)&&ts.isPropertyAccessExpression(call.expression)&&call.expression.name.text==='each'?evaluate(call.arguments[0],scope,ctx,depth):value()
      // Keep scalar table rows paired: separate unions cannot distinguish
      // deleting a case from attaching its pattern to another source path.
      if(rows.items?.length&&rows.items.every(row=>row.items?.length&&row.items.every(cell=>
        cell.strings.length===1&&!cell.reads.length&&!cell.items&&!cell.props&&!cell.fn
      )))next.tableRows=rows.items.map(row=>row.items.map(cell=>cell.strings[0]))
      if(['it','test'].includes(harnessCall.text))for(let current=scope;current;current=current.parent)for(const hook of current.hooks)invoke(hook,[],next,node,depth)
      for(const fn of args.filter(arg=>arg.fn))invoke(fn,fn.fn.parameters.map((_,i)=>union((rows.items??[]).map(row=>row.items?.[i]??row))),next,node,depth)
      return value()
    }
    if(ts.isPropertyAccessExpression(call)){
      let chain=call.expression,negated=false
      if(ts.isPropertyAccessExpression(chain)&&chain.name.text==='not'){negated=true;chain=chain.expression}
      if(ts.isCallExpression(chain)&&ts.isIdentifier(chain.expression)&&chain.expression.text==='expect'){
        matcher(name,negated,evaluate(chain.arguments[0],scope,ctx,depth),args[0]??value(),ctx,node);return value()
      }
      if(ts.isIdentifier(call.expression)&&scope.get(call.expression.text).assert){
        matcher(name,/^(?:doesNotMatch|notEqual|notStrictEqual)$/.test(name),args[0]??value(),args[1]??value(),ctx,node);return value()
      }
    }
    const receiver=ts.isPropertyAccessExpression(call)?evaluate(call.expression,scope,ctx,depth):value()
    const callable=evaluate(call,scope,ctx,depth)
    if(receiver.moduleLoader&&name==='resolve')return value({reads:union(args).reads})
    if(receiver.vitest&&name==='hoisted'&&args[0]?.fn)return invoke(args[0],[],ctx,node,depth)
    if(receiver.vitest&&name==='mock'&&args[0]?.strings.some(path=>/^(?:node:)?fs$/.test(path))&&args[1]?.fn){
      const mock=invoke(args[1],[],ctx,node,depth).props?.get('readFileSync')
      if(mock?.fn)mockedReaders.set(ctx.entry??ctx.file,mock)
      return value()
    }
    if(ts.isNewExpression(node)&&['Map','Set'].includes(callable.intrinsic))return value({container:callable.intrinsic,items:args[0]?.items??[],reads:union(args).reads})
    if(receiver.container&&name==='get')return union((receiver.items??[]).filter(row=>row.items?.[0]?.strings.some(key=>args[0]?.strings.includes(key))).map(row=>row.items[1]))
    if(receiver.container&&name==='add'){receiver.items.push(...args);receiver.reads=union(receiver.items).reads;return receiver}
    if(receiver.container&&['has','set','delete','clear','keys','values','entries'].includes(name))return value({reads:union([receiver,...args]).reads})
    if(['Object','Math'].includes(receiver.intrinsic))return union(args)
    if(ts.isNewExpression(node)&&callable.classNode){
      const instance=value({props:new Map()}),instanceScope=new Scope(callable.scope)
      instanceScope.set('this',instance)
      for(const member of callable.classNode.members){
        if(ts.isMethodDeclaration(member)||ts.isGetAccessorDeclaration(member))instance.props.set(member.name.text,value({fn:member,scope:instanceScope,ctx:callable.ctx,getter:ts.isGetAccessorDeclaration(member)}))
        else if(ts.isPropertyDeclaration(member))instance.props.set(member.name.text,evaluate(member.initializer,instanceScope,callable.ctx,depth))
      }
      const constructor=callable.classNode.members.find(ts.isConstructorDeclaration)
      if(constructor){
        constructor.parameters.forEach((param,i)=>{if(param.modifiers?.length&&ts.isIdentifier(param.name))instance.props.set(param.name.text,args[i]??value())})
        invoke(value({fn:constructor,scope:instanceScope,ctx:callable.ctx}),args,ctx,node,depth)
      }
      return instance
    }
    if(callable.reader){
      const mock=callable.readerName==='readFileSync'?mockedReaders.get(ctx.entry??ctx.file):null
      if(mock?.fn&&!active.has(mock.fn))return invoke(mock,args,ctx,node,depth)
      sourceCalls.set(node,'file');return read(args[0]??value(),ctx,node,callable.helper)
    }
    if(callable.fileInfo)return value()
    if(callable.pathIdentity)return args[0]??value()
    if(callable.hashFactory)return value({hash:true})
    if(receiver.hash&&name==='update')return {...union([receiver,...args]),hash:true}
    if(receiver.hash&&name==='digest')return value({reads:receiver.reads})
    if(receiver.intrinsic==='JSON'&&['parse','stringify'].includes(name)){
      const seen=new Set(),parts=[]
      const collect=part=>{if(!part||seen.has(part))return;seen.add(part);parts.push(part);for(const child of part.props?.values()??[])collect(child);for(const child of part.items??[])collect(child)}
      args.forEach(collect)
      return union(parts)
    }
    if(name==='require'&&args[0]?.strings.some(s=>/^(?:node:)?fs$/.test(s)))return fsModule()
    if(name==='require'&&args[0]?.strings.some(s=>/^(?:node:)?assert(?:\/strict)?$/.test(s)))return value({assert:true})
    if(callable.assertMatcher){matcher(callable.assertMatcher,/^doesNot|^not/.test(callable.assertMatcher),args[0]??value(),args[1]??value(),ctx,node);return value()}
    if(name==='join'&&receiver.items)return union(receiver.items)
    if(['join','resolve'].includes(name)&&!receiver.reads.length&&!callable.fn){
      let paths=['']
      for(const arg of args)if(arg.strings.length)paths=combine(paths,arg.strings.map(path=>'/'+path))
      return value({strings:atoms(paths.map(path=>posix.normalize(path.replace(/^\//,''))))})
    }
    if(['dirname','basename','extname','relative'].includes(name)&&!callable.fn&&!receiver.reads.length){
      if(!args[0]?.strings.length)return value()
      const strings=name==='relative'?args[0].strings.flatMap(from=>(args[1]?.strings??[]).map(to=>posix.relative(from,to))):args[0].strings.map(path=>posix[name](path))
      return value({strings:atoms(strings),reads:union(args).reads})
    }
    if(callable.moduleFactory)return value({moduleLoader:true})
    if(callable.moduleLoader&&args[0]?.strings.some(path=>/^(?:node:)?fs$/.test(path)))return fsModule()
    if(name==='fileURLToPath')return args[0]??value()
    if(name==='URL')return args[0]?.strings.length&&args[1]?.strings.length?value({strings:atoms(args[0].strings.flatMap(path=>args[1].strings.map(base=>posix.normalize(posix.join(posix.dirname(base),path)))))}) : args[0]??value()
    if(name==='mkdtempSync')return value({strings:['__fixture__/'+digest(ctx.file+ctx.test+canonical(node))]})
    if(name==='cwd'&&ts.isPropertyAccessExpression(call)&&ts.isIdentifier(call.expression)&&call.expression.text==='process')return value({strings:[/^apps\/[^/]+/.exec(ctx.file)?.[0]??'']})
    if(['execFileSync','execSync'].includes(name)||['spawnSync','spawn','execFile'].includes(name)&&!callable.fn){
      const command=args.flatMap(a=>a.strings).join(' ')
      if(/\b(?:show|cat|rg|grep)\b/.test(command)){
        const fixtureRoots=args.flatMap(arg=>arg.props?.get('cwd')?.strings??[]).filter(path=>path.startsWith('__fixture__/'))
        if(fixtureRoots.length)return union([...fixtureWrites].filter(([path])=>fixtureRoots.some(root=>path.startsWith(root+'/'))).map(([,content])=>content))
        return read(value({strings:[command]}),ctx,node)
      }
      return value()
    }
    if(['includes','startsWith','endsWith','test','indexOf'].includes(name))return {...union([receiver,...args]),...(name==='indexOf'?{index:true}:{predicate:{sign:1}})}
    if(['replace','replaceAll'].includes(name)&&receiver.strings.length&&!receiver.reads.length&&args[1]?.strings.length===1){
      const pattern=node.arguments[0]
      let search
      if(ts.isRegularExpressionLiteral(pattern)){const end=pattern.text.lastIndexOf('/');search=new RegExp(pattern.text.slice(1,end),pattern.text.slice(end+1))}
      else if(args[0]?.strings.length===1)search=args[0].strings[0]
      if(search!==undefined)return value({strings:atoms(receiver.strings.map(text=>text[name](search,args[1].strings[0])))})
    }
    if(transforms.has(name)){
      // Offsets and replacement patterns are arguments, not the text returned
      // by a string operation. Their provenance still flows into the result.
      let strings=receiver.strings
      if(['slice','substring','substr'].includes(name)&&args.every(arg=>arg.strings.length===1&&/^-?\d+$/.test(arg.strings[0])))strings=strings.map(text=>text[name](...args.map(arg=>Number(arg.strings[0]))))
      else if(['trim','trimStart','trimEnd','toLowerCase','toUpperCase'].includes(name))strings=strings.map(text=>text[name]())
      return {...union([receiver,...args]),strings,collection:['split','match','matchAll'].includes(name)}
    }
    if(['map','flatMap','filter','forEach','some','every'].includes(name)){
      if(['map','flatMap'].includes(name)&&receiver.items){
        const fn=args.find(arg=>arg.fn),items=fn?receiver.items.map((input,index)=>invoke(fn,[input,value({strings:[String(index)]})],ctx,node,depth)):[]
        return {...union(items),items,collection:true}
      }
      const fn=args.find(arg=>arg.fn),input=union(receiver.items??[receiver]),result=fn?invoke(fn,[input,value()],ctx,node,depth):value()
      return name==='forEach'?value():{...result,collection:true}
    }
    if(name==='createSourceFile')return value({astReads:union(args).reads,astRoot:true})
    if(['getText','getFullText'].includes(name)&&receiver.astReads?.length)return value({reads:receiver.astReads})
    if(name==='sort'&&receiver.collection)return receiver
    if(name==='push'&&receiver.items){receiver.items.push(...args);return value()}
    if(['writeFileSync','writeFile'].includes(name)){
      for(const path of args[0]?.strings??[])if(path.startsWith('__fixture__/'))fixtureWrites.set(path,union([fixtureWrites.get(path)??value(),args[1]??value()]))
      return value()
    }
    if(execution.has(name))return value()
    if(receiver.typescript)return value({typescript:true,astReads:union(args).astReads})
    if(callable.fn){
      const result=invoke(callable,args,ctx,node,depth)
      const body=callable.fn.body
      const returned=ts.isBlock(body)&&body.statements.length===1&&ts.isReturnStatement(body.statements[0])?body.statements[0].expression:body
      if(result.reads.length&&!args.some(arg=>arg.reads.length)&&sourceCalls.has(returned))sourceCalls.set(node,'file')
      return result
    }
    if(callable.functions?.length)return union(callable.functions.map(fn=>invoke(fn,args,ctx,node,depth)))
    if(callable.localModule&&args.some(arg=>arg.reads.length)){
      const fn=load(callable.localModule).exports.get(callable.exportName??'default')
      if(fn?.fn)return invoke(fn,args,ctx,node,depth)
    }
    if(ts.isIdentifier(call)&&scope.get(call.text).assert){matcher('toBeTruthy',false,args[0]??value(),value(),ctx,node);return value()}
    const raw=union([receiver,...args])
    if(raw.reads.length){emit(ctx,node,raw,value(),'unknown-source-consumer');return raw}
    if(args.some(arg=>arg.strings.some(target)))return read(union(args),ctx,node)
    return value()
  }
  const load = file => {
    if(modules.has(file))return modules.get(file)
    const source=files.get(file)??'',sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),scope=new Scope(),exports=new Map(),ctx={file,sf,test:''}
    scope.set('__dirname',value({strings:[posix.dirname(file)]}))
    scope.set('__filename',value({strings:[file]}))
    const mod={scope,exports};modules.set(file,mod)
    for(const statement of sf.statements){
      if(ts.isFunctionDeclaration(statement)&&statement.name)scope.set(statement.name.text,value({fn:statement,scope,ctx}))
      if(ts.isClassDeclaration(statement)&&statement.name)scope.set(statement.name.text,value({classNode:statement,scope,ctx}))
    }
    for(const statement of sf.statements){
      if(!ts.isImportDeclaration(statement))continue
      const specifier=statement.moduleSpecifier.text,local=modulePath(file,specifier)
      const pathModule=/^(?:node:)?path$/.test(specifier)?value({props:new Map(['join','resolve','dirname','basename','extname','relative'].map(pathOp=>[pathOp,value({pathOp})]))}):null
      const imported=pathModule??(/^(?:node:)?module$/.test(specifier)?value({props:new Map([['createRequire',value({moduleFactory:true})]])}):specifier==='vitest'?value({props:new Map([['vi',value({vitest:true})]])}):specifier==='typescript'?value({typescript:true}):specifier.includes('?raw')?read(value({strings:[specifier]}),ctx,statement):/^(?:node:)?fs(?:\/promises)?$/.test(specifier)?fsModule():/^(?:node:)?crypto$/.test(specifier)?value({props:new Map([['createHash',value({hashFactory:true})]])}):/^(?:node:)?assert(?:\/strict)?$/.test(specifier)?value({assert:true}):local?readers.has(local)?value({props:load(local).exports}):value({localModule:local}):value())
      const clause=statement.importClause
      if(clause?.name)scope.set(clause.name.text,imported.assert?imported:imported.localModule?value({localModule:local,exportName:'default'}):imported.props?.get('default')??imported)
      if(clause?.namedBindings&&ts.isNamespaceImport(clause.namedBindings))scope.set(clause.namedBindings.name.text,imported)
      else if(clause?.namedBindings)for(const binding of clause.namedBindings.elements){const original=binding.propertyName?.text??binding.name.text;let v=imported.assert?value({assertMatcher:original}):imported.localModule?value({localModule:local,exportName:original}):imported.props?.get(original)??value();if(original==='readUiSource'&&local)v=value({reader:true,helper:digest(canonical(load(local).scope.get(original).fn))});scope.set(binding.name.text,v)}
    }
    for(const statement of sf.statements)if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&ts.isIdentifier(statement.expression.expression)&&['beforeEach','beforeAll'].includes(statement.expression.expression.text)){
      const fn=statement.expression.arguments.find(arg=>ts.isArrowFunction(arg)||ts.isFunctionExpression(arg))
      if(fn){scope.hookNodes.add(fn);scope.hooks.push(value({fn,scope,ctx}))}
    }
    statements(sf.statements,scope,ctx,0)
    for(const statement of sf.statements){
      if(statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
        if(ts.isFunctionDeclaration(statement)&&statement.name)exports.set(statement.modifiers.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)?'default':statement.name.text,scope.get(statement.name.text))
        if(ts.isClassDeclaration(statement)&&statement.name)exports.set(statement.modifiers.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)?'default':statement.name.text,scope.get(statement.name.text))
        if(ts.isVariableStatement(statement))for(const decl of statement.declarationList.declarations)if(ts.isIdentifier(decl.name))exports.set(decl.name.text,scope.get(decl.name.text))
      }
      if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause)){
        const target=statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)?modulePath(file,statement.moduleSpecifier.text):null
        for(const binding of statement.exportClause.elements){
          const name=binding.propertyName?.text??binding.name.text
          exports.set(binding.name.text,target?load(target).exports.get(name)??value():scope.get(name))
        }
      }
    }
    return mod
  }
  // The bound protects one root analysis; adding independent test files must
  // not consume another root's budget. A costly root still fails closed.
  for(const entry of entries){steps=0;load(entry)}
  return findings
}

export const isTest = path => /^(?:apps\/(?:web|worker|liff)\/|scripts\/).*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)

/** Git cannot pair a split module once its wrapper drops below rename similarity.
 * A unique, named default implementation retains its identity across the split.
 * Re-exports and generic anonymous defaults are deliberately not candidates.
 */
export function splitModuleMoves(before, after, moves = new Map()) {
  const primary = (file, source) => {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    for (const node of ast.statements) {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && node.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return node.name.text
    }
  }
  const candidates = new Map(), result = new Map(moves)
  // A retained compatibility entry may forward all exports to its renamed
  // implementation. Require a pure, single-target re-export, never imports or
  // a wrapper with executable statements.
  for(const [file,source]of before){
    if(isTest(file)||result.has(file)||!after.has(file))continue
    const ast=ts.createSourceFile(file,after.get(file),ts.ScriptTarget.Latest,true)
    if(!ast.statements.length||!ast.statements.every(node=>ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&node.exportClause&&ts.isNamedExports(node.exportClause)))continue
    if(!ast.statements.some(node=>node.exportClause.elements.some(binding=>binding.name.text==='default'&&(binding.propertyName?.text??binding.name.text)==='default')))continue
    const specifiers=[...new Set(ast.statements.map(node=>node.moduleSpecifier.text))]
    if(specifiers.length!==1||!specifiers[0].startsWith('.'))continue
    const stem=posix.normalize(posix.join(posix.dirname(file),specifiers[0]))
    const target=[stem,stem+'.ts',stem+'.tsx',stem.replace(/\.js$/,'.ts'),stem.replace(/\.js$/,'.tsx')].find(path=>after.has(path)&&path!==file)
    if(target&&primary(file,source)&&primary(target,after.get(target))===primary(file,source))result.set(file,target)
  }
  for (const [file, source] of after) {
    if (isTest(file)) continue
    const name = primary(file, source)
    if (name) candidates.set(name, [...(candidates.get(name) ?? []), file])
  }
  for (const [file, source] of before) {
    if (after.has(file) || result.has(file) || isTest(file)) continue
    const name = primary(file, source), matches = candidates.get(name) ?? []
    if (matches.length === 1) result.set(file, matches[0])
  }
  return result
}
export function newSourceAssertions(before, after, moves = new Map(), sourceFiles = new Map()) {
  const pathIndexes = new Map()
  const pathsFor = file => {
    if (pathIndexes.has(file)) return pathIndexes.get(file)
    const paths = new Map(), movedFile = moves.get(file) ?? file
    for (const [from, to] of moves) {
      const styles = [[from, to], [posix.relative(posix.dirname(file), from), posix.relative(posix.dirname(movedFile), to)]]
      if (from.startsWith('apps/web/') && to.startsWith('apps/web/')) styles.push([from.slice(9), to.slice(9)])
      for (const [old, next] of styles) {
        if (!paths.has(old)) paths.set(old, next)
        if (!paths.has('./' + old)) paths.set('./' + old, './' + next)
      }
    }
    pathIndexes.set(file, paths)
    return paths
  }
  const identity = (hit, plainReader = false, remap = true, remapReads = true) => {
    const parts = JSON.parse(hit.key)
    if (remap) {
      const rewrite=item=>Array.isArray(item)?item.map(rewrite):typeof item==='string'?(pathsFor(hit.file).get(item)??item):item
      parts[0] = moves.get(parts[0]) ?? parts[0]
      parts[1] = moves.get(parts[1]) ?? parts[1]
      if(remapReads){parts[4] = JSON.stringify(rewrite(JSON.parse(parts[4])));parts[5] = rewrite(parts[5])}
      if(remapReads)parts[3] = parts[3].map(read => {
        const [path, helper] = read.split('|helper:')
        const unknownPrefix='unknown:'+hit.file+':'
        if(path.startsWith(unknownPrefix)) {
          const node=JSON.parse(path.slice(unknownPrefix.length))
          return 'unknown:'+parts[1]+':'+JSON.stringify(rewrite(node))+(helper?'|helper:'+helper:'')
        }
        const next = pathsFor(hit.file).get(path)
        if (next !== undefined) return next + (helper ? '|helper:' + helper : '')
        return read
      }).sort()
    }
    if (plainReader) parts[3] = [...new Set(parts[3].map(path => path.replace(/\|helper:[a-f0-9]+$/, '')))].sort()
    return JSON.stringify(parts)
  }
  const remaining = new Map()
  const baselineReaders = new Set(before.flatMap(hit => hit.reads.flatMap(path => path.match(/\|helper:([a-f0-9]+)$/)?.slice(1) ?? [])))
  for (const hit of before) {
    const key = identity(hit)
    const list = remaining.get(key) ?? []
    list.push(hit)
    remaining.set(key, list)
  }
  const unmatched = after.filter(hit => {
    // after already uses the new paths; only remap the base side.
    const list = remaining.get(hit.key)
    if (!list?.length) return true
    list.pop()
    return false
  })
  const dependencies = new Map()
  const importedFiles = file => {
    if(dependencies.has(file))return dependencies.get(file)
    const reachable=new Set(),pending=[file]
    while(pending.length){
      const next=pending.pop()
      if(reachable.has(next))continue
      reachable.add(next)
      for(const {fileName}of ts.preProcessFile(sourceFiles.get(next)??'',true,true).importedFiles){
        const stem=fileName.startsWith('@/')?'apps/web/src/'+fileName.slice(2):fileName.startsWith('.')?posix.normalize(posix.join(posix.dirname(next),fileName)):''
        const target=[stem,stem+'.ts',stem+'.tsx',stem+'/index.ts'].find(path=>sourceFiles.has(path))
        if(target)pending.push(target)
      }
    }
    dependencies.set(file,reachable)
    return reachable
  }
  return unmatched.filter(hit => {
    if (hit.reads.some(path => /\|helper:/.test(path) && !baselineReaders.has(path.match(/\|helper:([a-f0-9]+)$/)?.[1]))) return true
    // readUiSource preserves the requested root while following its split files.
    // Only a reader already observed in the base qualifies. A new or changed
    // helper, a read root, a test or an assertion still fails.
    const plain = identity(hit, true, false)
    for (const list of remaining.values()) {
      const index = list.findIndex(old => {
        const newParts=JSON.parse(plain)
        for(const remapReads of [true,false]){
          const oldParts=JSON.parse(identity(old,true,true,remapReads))
          // A human-readable case title is not an assertion. The file, source
          // provenance, expression and expected values still match one-to-one.
          oldParts[2]=newParts[2]
          if(JSON.stringify(oldParts)===plain)return true
          const oldRoots=oldParts[3],newRoots=newParts[3]
          if(newRoots.length&&newRoots.every(root=>oldRoots.includes(root))){
            const subset=[...oldParts];subset[3]=newRoots
            if(JSON.stringify(subset)===plain)return true
            // A literal table may lose cases as assertions move to behavior
            // tests. Require an actual row deletion, preserving each remaining
            // path/pattern pair and consuming duplicate rows only once.
            if(newRoots.length<oldRoots.length&&newParts[5].length&&newParts[5].length<oldParts[5].length
              &&newParts[5].every(text=>oldParts[5].includes(text))
              &&old.tableRows&&hit.tableRows?.length&&hit.tableRows.length<old.tableRows.length){
              const priorRows=old.tableRows.map(row=>JSON.stringify(row.map(text=>remapReads?(pathsFor(old.file).get(text)??text):text)))
              const removedOnly=hit.tableRows.every(row=>{
                const index=priorRows.indexOf(JSON.stringify(row))
                if(index<0)return false
                priorRows.splice(index,1)
                return true
              })
              subset[5]=newParts[5]
              if(removedOnly&&JSON.stringify(subset)===plain)return true
            }
          }
          // Extracted code may be read explicitly alongside its old root. Only
          // actual imports of that retained root qualify; unrelated new roots fail.
          if(!oldRoots.length||!oldRoots.every(path=>newRoots.includes(path)))continue
          if(!newRoots.every(path=>oldRoots.includes(path)||oldRoots.some(root=>importedFiles(root).has(path))))continue
          oldParts[3]=newRoots
          if(JSON.stringify(oldParts)===plain)return true
        }
        return false
      })
      if (index >= 0) { list.splice(index, 1); return false }
    }
    return true
  })
}

export function checkRepository(root, base) {
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024})
  const names=git('ls-files','-z').split('\0').filter(Boolean)
  const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean)
  const baseNames=git('ls-tree','-r','--name-only','-z',base).split('\0').filter(Boolean)
  const load=(paths,ref)=>{
    const selected=paths.filter(path=>/^(?:apps\/(?:web|worker|liff)\/|scripts\/)/.test(path)&&/\.(?:[cm]?[jt]sx?)$/.test(path))
    if(!ref)return new Map(selected.map(path=>[path,existsSync(resolve(root,path))?readFileSync(resolve(root,path),'utf8'):'']))
    if(selected.some(path=>/[\r\n]/.test(path)))throw Error('Unsupported newline in source path')
    const bytes=execFileSync('git',['cat-file','--batch'],{cwd:root,input:selected.map(path=>ref+':'+path).join('\n')+'\n',maxBuffer:128*1024*1024})
    const result=new Map();let offset=0
    for(const path of selected){
      const end=bytes.indexOf(10,offset),header=bytes.subarray(offset,end).toString('utf8'),match=/^[a-f0-9]+ blob (\d+)$/.exec(header)
      if(!match)throw Error(`Cannot read base source: ${path}`)
      const length=Number(match[1]);offset=end+1;result.set(path,bytes.subarray(offset,offset+length).toString('utf8'));offset+=length+1
    }
    return result
  }
  const baseSources=load(baseNames,base),currentSources=load([...new Set([...names,...untracked])])
  const before=analyzeSourceTests(baseSources),after=analyzeSourceTests(currentSources)
  const changes=git('-c','diff.renameLimit=0','diff','--name-status','-z','-M50%',base).split('\0'),moves=new Map()
  for(let i=0;i<changes.length;){const status=changes[i++];if(!status)break;const from=changes[i++];if(status.startsWith('R'))moves.set(from,changes[i++])}
  const lineage=splitModuleMoves(baseSources,currentSources,moves)
  return {base,examined:after.length,moves:Object.fromEntries(lineage),findings:newSourceAssertions(before,after,lineage,currentSources)}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--base'),base=index>=0?process.argv[index+1]:process.env.SOURCE_CONTRACT_BASE_SHA
  if(!base)throw Error('B-273 requires --base <PR base SHA>')
  const report=checkRepository(process.cwd(),base)
  for(const hit of report.findings)console.error(`${hit.file}:${hit.line} ${hit.test}\n  ${hit.reason}: ${hit.expression}\n  reads: ${hit.reads.join(', ')}`)
  console.log(`B-273: new source assertions ${report.findings.length}`)
  if(report.findings.length)process.exitCode=1
}
