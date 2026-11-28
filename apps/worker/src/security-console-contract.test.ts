import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function unsafeConsoleCalls(source: string, readDependency: (specifier: string) => string | undefined = () => undefined): number[] {
  const file=ts.createSourceFile('security-source.ts',source,ts.ScriptTarget.Latest,true);
  const failures:number[]=[];
  function binding(name:string,at:ts.Node):ts.Expression|undefined {
    for(let ancestor:ts.Node|undefined=at;ancestor;ancestor=ancestor.parent) if(ts.isBlock(ancestor)||ts.isSourceFile(ancestor)) {
      for(const statement of ancestor.statements) if(ts.isVariableStatement(statement)) for(const declaration of statement.declarationList.declarations)
        if(ts.isIdentifier(declaration.name)&&declaration.name.text===name)return declaration.initializer;
    }
  }
  function constantCode(node:ts.Expression,at:ts.Node,depth=0):boolean {
    if(depth>5)return false;
    if(ts.isStringLiteral(node))return true;
    if(ts.isConditionalExpression(node))return constantCode(node.whenTrue,at,depth+1)&&constantCode(node.whenFalse,at,depth+1);
    if(ts.isIdentifier(node)){const value=binding(node.text,at);return !!value&&constantCode(value,at,depth+1);}
    return false;
  }
  function safeRoute(node:ts.Expression,at:ts.Node,depth=0):boolean {
    if(depth>5)return false;
    if(ts.isStringLiteral(node))return !node.text.includes('?');
    if(ts.isPropertyAccessExpression(node)&&node.name.text==='routePath')return true;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.BarBarToken)return safeRoute(node.left,at,depth+1)&&safeRoute(node.right,at,depth+1);
    if(ts.isIdentifier(node)){const value=binding(node.text,at);return !!value&&safeRoute(value,at,depth+1);}
    if(ts.isTemplateExpression(node))return node.templateSpans.every(span=>safeRoute(span.expression,at,depth+1));
    // HTTP メソッドは固定の許可集合へ絞った後でだけ表示できる。
    if(ts.isConditionalExpression(node)&&ts.isStringLiteral(node.whenFalse)&&node.whenFalse.text==='OTHER') {
      return node.condition.getText(file)==="/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(c.req.method)";
    }
    return false;
  }
  // 分類名は変更されない固定集合への所属を検証した場合だけ安全とする。import した一覧は凍結した定義に限る。
  function shadows(tree:ts.Node,name:string,allowed?:ts.Node):boolean {
    let found=false;
    function visit(node:ts.Node){
      if((ts.isVariableDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)||ts.isImportSpecifier(node)
        ||ts.isImportClause(node)||ts.isNamespaceImport(node)||ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)
        ||ts.isClassDeclaration(node)||ts.isClassExpression(node)||ts.isEnumDeclaration(node)||ts.isModuleDeclaration(node)||ts.isImportEqualsDeclaration(node))
        &&node.name&&node.name!==allowed&&ts.isIdentifier(node.name)&&node.name.text===name)found=true;
      ts.forEachChild(node,visit);
    }
    visit(tree);return found;
  }
  function unwrap(node:ts.Expression):ts.Expression {
    return ts.isParenthesizedExpression(node)||ts.isAsExpression(node)?unwrap(node.expression):node;
  }
  function frozenImportedRecord(name:string):boolean {
    if(shadows(file,'Object'))return false;
    for(const statement of file.statements){
      if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier))continue;
      const names=statement.importClause?.namedBindings;
      if(!names||!ts.isNamedImports(names))continue;
      const entry=names.elements.find(item=>item.name.text===name);if(!entry)continue;
      if(shadows(file,name,entry.name))return false;
      const content=readDependency(statement.moduleSpecifier.text);if(content===undefined)return false;
      const module=ts.createSourceFile('category-registry.ts',content,ts.ScriptTarget.Latest,true);
      if(shadows(module,'Object'))return false;
      const exported=entry.propertyName?.text??entry.name.text;
      for(const declaration of module.statements){
        if(!ts.isVariableStatement(declaration)||!(declaration.declarationList.flags&ts.NodeFlags.Const)
          ||!declaration.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))continue;
        const variable=declaration.declarationList.declarations.find(item=>ts.isIdentifier(item.name)&&item.name.text===exported);
        if(!variable?.initializer)continue;
        const expression=unwrap(variable.initializer);
        if(!ts.isCallExpression(expression)||expression.expression.getText(module)!=='Object.freeze'||expression.arguments.length!==1)return false;
        const record=unwrap(expression.arguments[0]);
        return ts.isObjectLiteralExpression(record)&&record.properties.length>0&&record.properties.every(property=>
          ts.isPropertyAssignment(property)&&(ts.isIdentifier(property.name)||ts.isStringLiteral(property.name))
          &&ts.isStringLiteral(property.initializer)&&/^[a-z][a-z0-9_]{0,95}$/.test(property.initializer.text));
      }
    }
    return false;
  }
  function closedSet(name:string,literalPattern=/^[a-z][a-z0-9_]{0,95}$/):boolean {
    if(shadows(file,'Set'))return false;
    const declarations:ts.VariableDeclaration[]=[];
    function collect(node:ts.Node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name)declarations.push(node);ts.forEachChild(node,collect);}
    collect(file);
    const declaration=declarations[0];
    if(declarations.length!==1||!ts.isVariableDeclarationList(declaration.parent)||!(declaration.parent.flags&ts.NodeFlags.Const)||!declaration.initializer)return false;
    const initializer=unwrap(declaration.initializer);
    if(!ts.isNewExpression(initializer)||!ts.isIdentifier(initializer.expression)||initializer.expression.text!=='Set'||initializer.arguments?.length!==1)return false;
    const entries=unwrap(initializer.arguments[0]);
    if(!ts.isArrayLiteralExpression(entries)||!entries.elements.length)return false;
    const fixed=entries.elements.every(entry=>{
      if(ts.isStringLiteral(entry))return literalPattern.test(entry.text);
      if(!ts.isSpreadElement(entry)||!ts.isCallExpression(entry.expression))return false;
      const values=entry.expression;
      return values.expression.getText(file)==='Object.values'&&values.arguments.length===1
        &&ts.isIdentifier(values.arguments[0])&&frozenImportedRecord(values.arguments[0].text);
    });
    if(!fixed)return false;
    let immutable=true;
    function check(node:ts.Node){
      if(ts.isIdentifier(node)&&node.text===name&&node!==declaration.name){
        const member=node.parent;
        if(!ts.isPropertyAccessExpression(member)||member.expression!==node||member.name.text!=='has'
          ||!ts.isCallExpression(member.parent)||member.parent.expression!==member)immutable=false;
      }
      ts.forEachChild(node,check);
    }
    check(file);return immutable;
  }
  function categoryMembership(condition:ts.Expression,input:string,literalPattern?:RegExp):boolean {
    const guard=unwrap(condition);
    return ts.isCallExpression(guard)&&ts.isPropertyAccessExpression(guard.expression)
      &&guard.expression.name.text==='has'&&ts.isIdentifier(guard.expression.expression)
      &&guard.arguments.length===1&&guard.arguments[0].getText(file)===input
      &&closedSet(guard.expression.expression.text,literalPattern);
  }
  function categoryConditions(node:ts.Expression):ts.Expression[] {
    const condition=unwrap(node);
    if(ts.isBinaryExpression(condition)&&condition.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken)
      return [...categoryConditions(condition.left),...categoryConditions(condition.right)];
    return [condition];
  }
  function safeCategorySpread(node:ts.Expression):boolean {
    const expression=unwrap(node);
    if(!ts.isConditionalExpression(expression)||!ts.isObjectLiteralExpression(expression.whenTrue)
      ||!ts.isObjectLiteralExpression(expression.whenFalse)||expression.whenFalse.properties.length)return false;
    const {properties}=expression.whenTrue;
    const conditions=categoryConditions(expression.condition);
    if(properties.length===3){
      const billingFields=[
        ['billingEventType','metrics.billingWebhook.eventType',/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2}$/],
        ['billingStage','metrics.billingWebhook.stage',undefined],
        ['billingReason','metrics.billingWebhook.reason',undefined],
      ] as const;
      return conditions.length===4&&conditions[0].getText(file)==='metrics.billingWebhook'
        &&billingFields.every(([field,input,format],index)=>{
          const property=properties[index];
          return ts.isPropertyAssignment(property)&&ts.isIdentifier(property.name)&&property.name.text===field
            &&property.initializer.getText(file)===input&&categoryMembership(conditions[index+1],input,format);
        });
    }
    if(properties.length!==1||conditions.length!==2)return false;
    const property=properties[0];
    if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name)||!['scheduledJob','failureKind'].includes(property.name.text))return false;
    const input=`metrics.${property.name.text}`;
    return property.initializer.getText(file)===input&&conditions[0].getText(file)===input&&categoryMembership(conditions[1],input);
  }
  // 共通serializerだけは、自由な文を含まない厳密な構造と採番元を検査する。
  function safeIntegerMetric(text:string):boolean {
    const match=/^Number\.isInteger\(metrics\.(failedCount|upstreamCode|upstreamSubcode)\)&&metrics\.\1!>=0(?:&&metrics\.\1!<=999999999)?\?\{\1:metrics\.\1\}:\{\}$/.exec(text);
    return !!match && (match[1]==='failedCount' || text.includes('<=999999999'));
  }
  function safeEnvelope(node:ts.Expression,at:ts.Node):boolean {
    if(ts.isIdentifier(node)){const value=binding(node.text,at);return !!value&&safeEnvelope(value,at);}
    if(!ts.isObjectLiteralExpression(node))return false;
    const fields=new Map<string,string>();
    for(const property of node.properties){
      if(ts.isSpreadAssignment(property)){
        const expression=ts.isParenthesizedExpression(property.expression)?property.expression.expression:property.expression;
        const text=expression.getText(file).replace(/\s+/g,'');
        if(!safeCategorySpread(expression)&&!safeIntegerMetric(text)&&!/^Number\.isInteger\(metrics\.status\).*\?\{status:metrics\.status\}:\{\}$/.test(text)
          &&!/^Number\.isFinite\(metrics\.durationMs\).*\?\{durationMs:Math\.round\(metrics\.durationMs!\)\}:\{\}$/.test(text))return false;
        continue;
      }
      if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property))return false;
      fields.set(property.name.getText(file), (ts.isPropertyAssignment(property)?property.initializer:property.name).getText(file).replace(/\s+/g,''));
    }
    if(fields.size!==6||fields.get('timestamp')!=="newDate().toISOString()"||fields.get('level')!=="level==='log'?'info':level")return false;
    const code=fields.get('code')??'';
    if(!/^\/\^\[.*\]\[.*\]\{0,95\}\$\/\.test\(code\)\?code:'invalid_log_event'$/.test(code))return false;
    const server=fields.get('requestId')==='context?.requestId??null'&&fields.get('invocationId')==='context?.invocationId??null'&&fields.get('source')==="context?.source??'background'";
    const clientId=binding('requestId',at)?.getText(file).replace(/\s+/g,'')??'';
    const client=fields.get('requestId')==='requestId'&&fields.get('invocationId')==='null'&&fields.get('source')==='source'
      &&clientId.includes("typeofid==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)?id:null");
    return server||client;
  }
  // 障害 ID は同じスコープで Web Crypto が生成したと確認できる場合だけ許可する。入力値・可変の別名・同名の上書きは拒み、パス別の除外にしない。
  function serverIncidentId(node:ts.Expression,at:ts.Node):boolean {
    function binds(name:ts.BindingName,target:string):boolean {
      return ts.isIdentifier(name) ? name.text===target
        : name.elements.some(element=>ts.isBindingElement(element)&&binds(element.name,target));
    }
    let cryptoShadowed=false;
    function findShadow(current:ts.Node) {
      if ((ts.isVariableDeclaration(current)||ts.isParameter(current)||ts.isBindingElement(current)
        ||ts.isImportSpecifier(current)||ts.isImportClause(current)||ts.isNamespaceImport(current)
        ||ts.isFunctionDeclaration(current)||ts.isFunctionExpression(current)||ts.isClassDeclaration(current)
        ||ts.isClassExpression(current)||ts.isEnumDeclaration(current)||ts.isModuleDeclaration(current)||ts.isImportEqualsDeclaration(current))
        &&current.name&&ts.isIdentifier(current.name)&&current.name.text==='crypto') cryptoShadowed=true;
      ts.forEachChild(current,findShadow);
    }
    findShadow(file);
    if(cryptoShadowed||!ts.isIdentifier(node))return false;
    const name=node.text;
    for(let ancestor:ts.Node|undefined=at;ancestor;ancestor=ancestor.parent) {
      if(ts.isCatchClause(ancestor)&&ancestor.variableDeclaration&&binds(ancestor.variableDeclaration.name,name))return false;
      if((ts.isClassDeclaration(ancestor)||ts.isClassExpression(ancestor))&&ancestor.name?.text===name)return false;
      if(ts.isFunctionLike(ancestor)&&(ancestor.parameters.some(parameter=>binds(parameter.name,name))
        ||ancestor.name&&ts.isIdentifier(ancestor.name)&&ancestor.name.text===name))return false;
      if(!ts.isBlock(ancestor)&&!ts.isSourceFile(ancestor))continue;
      for(const statement of ancestor.statements) {
        if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement)||ts.isEnumDeclaration(statement))
          &&statement.name?.text===name)return false;
        if(!ts.isVariableStatement(statement))continue;
        for(const declaration of statement.declarationList.declarations) {
          if(!binds(declaration.name,name))continue;
          if(!ts.isIdentifier(declaration.name))return false;
          const value=declaration.initializer;
          return Boolean(statement.declarationList.flags&ts.NodeFlags.Const)
            &&!!value&&ts.isCallExpression(value)&&value.expression.getText(file)==='crypto.randomUUID'
            &&value.arguments.length===0;
        }
      }
    }
    return false;
  }
  function safePayload(node:ts.Expression,at:ts.Node):boolean {
    if(ts.isStringLiteral(node))return true;
    if(!ts.isCallExpression(node)||node.expression.getText(file)!=='JSON.stringify'||node.arguments.length!==1)return false;
    if(safeEnvelope(node.arguments[0],at))return true;
    if(!ts.isObjectLiteralExpression(node.arguments[0]))return false;
    let hasCode=false;
    return node.arguments[0].properties.every(property=>{
      if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property))return false;
      const key=property.name.getText(file).replace(/^['"]|['"]$/g,'');
      const value=ts.isPropertyAssignment(property)?property.initializer:property.name;
      if(key==='code'){hasCode=true;return constantCode(value,at);}
      if(key==='incidentId')return serverIncidentId(value,at);
      return key==='route'&&safeRoute(value,at);
    })&&hasCode;
  }
  function visit(node:ts.Node) {
    if(ts.isCallExpression(node)&&(ts.isPropertyAccessExpression(node.expression)||ts.isElementAccessExpression(node.expression))
      &&node.expression.expression.getText(file)==='console') {
      if(node.arguments.length!==1||!safePayload(node.arguments[0],node))failures.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line+1);
    }
    ts.forEachChild(node,visit);
  }
  visit(file);return failures;
}

it('S14 catches raw exceptions, identifier-bearing paths, URL objects and dynamic log codes',()=>{
  for(const source of ["console.error('operation_failed', error)","console.warn(JSON.stringify({code:'failed',route:c.req.path}))","console.log(JSON.stringify({code:body.token}))","console.info(JSON.stringify({code:'failed',...body}))"])
    expect(unsafeConsoleCalls(source)).toHaveLength(1);
  expect(unsafeConsoleCalls("console.error(JSON.stringify({code:'provider_failed',route:'POST /api/items/:id'}))")).toEqual([]);
});

it('accepts locally minted incident UUIDs and rejects caller IDs and shadowed or mutable bindings',()=>{
  expect(unsafeConsoleCalls("const incidentId=crypto.randomUUID();console.error(JSON.stringify({code:'failed',incidentId}));")).toEqual([]);
  expect(unsafeConsoleCalls("const incidentId=crypto.randomUUID();Promise.resolve().catch(()=>console.error(JSON.stringify({code:'failed',incidentId}))); ")).toEqual([]);
  for(const source of [
    "console.error(JSON.stringify({code:'failed',incidentId:body.id}));",
    "const incidentId='9cda509d-a57a-4bbe-9090-cf8ccf0c6c9b';console.error(JSON.stringify({code:'failed',incidentId}));",
    "let incidentId=crypto.randomUUID();console.error(JSON.stringify({code:'failed',incidentId}));",
    "const incidentId=crypto.randomUUID();function send(incidentId){console.error(JSON.stringify({code:'failed',incidentId}));}",
    "const incidentId=crypto.randomUUID();{const incidentId=body.id;console.error(JSON.stringify({code:'failed',incidentId}));}",
    "const incidentId=crypto.randomUUID();{const {incidentId}=body;console.error(JSON.stringify({code:'failed',incidentId}));}",
    "const incidentId=crypto.randomUUID();try{}catch(incidentId){console.error(JSON.stringify({code:'failed',incidentId}));}",
    "const crypto=body;const incidentId=crypto.randomUUID();console.error(JSON.stringify({code:'failed',incidentId}));",
    "namespace crypto {export function randomUUID(){return body.id;}}const incidentId=crypto.randomUUID();console.error(JSON.stringify({code:'failed',incidentId}));",
    "(function crypto(){const incidentId=crypto.randomUUID();console.error(JSON.stringify({code:'failed',incidentId}));})();",
  ])expect(unsafeConsoleCalls(source)).toHaveLength(1);
});

it('category fields require exact membership checks and immutable literal sets',()=>{
  const envelope=(prefix:string,spread:string)=>`${prefix};function write(level,code,metrics){const context=currentInvocation();const event={timestamp:new Date().toISOString(),level:level==='log'?'info':level,code:/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(code)?code:'invalid_log_event',requestId:context?.requestId??null,invocationId:context?.invocationId??null,source:context?.source??'background',...(${spread})};console.error(JSON.stringify(event));}`;
  const checked="metrics.scheduledJob && categories.has(metrics.scheduledJob) ? {scheduledJob:metrics.scheduledJob} : {}";
  expect(unsafeConsoleCalls(envelope("const categories=new Set(['booking_expirer'])",checked))).toEqual([]);
  for(const prefix of ["let categories=new Set(['booking_expirer'])","const categories=new Set([body.category])","const categories=new Set(['booking_expirer']);categories.add(body.category)","const categories=new Set(['booking_expirer']);const alias=categories","const Set=body.Set;const categories=new Set(['booking_expirer'])"])
    expect(unsafeConsoleCalls(envelope(prefix,checked))).toHaveLength(1);
  for(const spread of ["metrics.scheduledJob ? {scheduledJob:metrics.scheduledJob} : {}","metrics.scheduledJob && categories.has(metrics.failureKind) ? {scheduledJob:metrics.scheduledJob} : {}","metrics.scheduledJob && categories.has(metrics.scheduledJob) ? {scheduledJob:body.category} : {}"])
    expect(unsafeConsoleCalls(envelope("const categories=new Set(['booking_expirer'])",spread))).toHaveLength(1);
  const imported=envelope("import {codes} from './registry.js';const categories=new Set([...Object.values(codes),'unknown'])",checked);
  expect(unsafeConsoleCalls(imported,()=>"export const codes=Object.freeze({job:'booking_expirer'} as const)")).toEqual([]);
  const shadowed=imported.replace("const categories=new Set([...Object.values(codes),'unknown'])",'').replace('function write(level,code,metrics){',"function write(level,code,metrics,codes){const categories=new Set([...Object.values(codes),'unknown']);");
  expect(unsafeConsoleCalls(shadowed,()=>"export const codes=Object.freeze({job:'booking_expirer'})")).toHaveLength(1);
  for(const registry of ["export const codes={job:'booking_expirer'} as const","export const codes=Object.freeze({job:body.category})","const Object=body.Object;export const codes=Object.freeze({job:'booking_expirer'})"])
    expect(unsafeConsoleCalls(imported,()=>registry)).toHaveLength(1);
});

it('billing diagnostic fields require matched closed-set checks for the entire group',()=>{
  const prefix="const types=new Set(['invoice.paid']);const stages=new Set(['contract']);const reasons=new Set(['schema_missing']);";
  const checked="metrics.billingWebhook && types.has(metrics.billingWebhook.eventType) && stages.has(metrics.billingWebhook.stage) && reasons.has(metrics.billingWebhook.reason) ? {billingEventType:metrics.billingWebhook.eventType,billingStage:metrics.billingWebhook.stage,billingReason:metrics.billingWebhook.reason} : {}";
  const envelope=(setup:string,spread:string)=>`${setup}function write(level,code,metrics){const context=currentInvocation();const event={timestamp:new Date().toISOString(),level:level==='log'?'info':level,code:/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(code)?code:'invalid_log_event',requestId:context?.requestId??null,invocationId:context?.invocationId??null,source:context?.source??'background',...(${spread})};console.error(JSON.stringify(event));}`;
  expect(unsafeConsoleCalls(envelope(prefix,checked))).toEqual([]);
  for(const invalid of [
    checked.replace(' && reasons.has(metrics.billingWebhook.reason)',''),
    checked.replace('types.has(metrics.billingWebhook.eventType)','types.has(metrics.billingWebhook.stage)'),
    checked.replace('billingReason:metrics.billingWebhook.reason','billingReason:body.customerId'),
    checked.replace('billingReason:metrics.billingWebhook.reason','billingReason:metrics.billingWebhook.reason,raw:body'),
  ])expect(unsafeConsoleCalls(envelope(prefix,invalid))).toHaveLength(1);
  expect(unsafeConsoleCalls(envelope(prefix+"types.add(body.eventType);",checked))).toHaveLength(1);
  expect(unsafeConsoleCalls(envelope(prefix.replace("'invoice.paid'","body.eventType"),checked))).toHaveLength(1);
});

it('S14 production console calls carry fixed codes, route templates and proven server UUIDs only',()=>{
  const root=resolve(import.meta.dirname,'../../..');
  const findings:string[]=[];
  function walk(directory:string) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isDirectory()){if(entry.name!=='test-utils')walk(path);continue;}
      if(!/\.(ts|tsx)$/.test(path)||/\.(test|spec)\./.test(path))continue;
      const source=readFileSync(path,'utf8');if(!source.includes('console'))continue;
      findings.push(...unsafeConsoleCalls(source,specifier=>{
        if(!specifier.startsWith('.'))return undefined;
        try{return readFileSync(resolve(dirname(path),specifier.replace(/\.js$/,'.ts')),'utf8');}catch{return undefined;}
      }).map(line=>`${path.slice(root.length+1)}:${line}`));
    }
  }
  for(const directory of ['apps/worker/src','apps/web/src','apps/liff/src','packages/db/src','packages/line-sdk/src','packages/shared/src','packages/sdk/src','packages/mcp-server/src'])walk(join(root,directory));
  expect(findings).toEqual([]);
});

it('integer diagnostic metrics retain bounds and cannot copy arbitrary input',()=>{
  const envelope=(spread:string)=>`function write(level,code,metrics){const context=currentInvocation();const event={timestamp:new Date().toISOString(),level:level==='log'?'info':level,code:/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(code)?code:'invalid_log_event',requestId:context?.requestId??null,invocationId:context?.invocationId??null,source:context?.source??'background',...(${spread})};console.error(JSON.stringify(event));}`;
  for(const field of ['failedCount','upstreamCode','upstreamSubcode']) {
    const bounded=`Number.isInteger(metrics.${field}) && metrics.${field}! >= 0 && metrics.${field}! <= 999999999 ? {${field}:metrics.${field}} : {}`;
    expect(unsafeConsoleCalls(envelope(bounded))).toEqual([]);
    expect(unsafeConsoleCalls(envelope(bounded.replace(`metrics.${field}! >= 0 && `,'')))).toHaveLength(1);
    expect(unsafeConsoleCalls(envelope(bounded.replace(`{${field}:metrics.${field}}`,`{${field}:body.value}`)))).toHaveLength(1);
  }
});
