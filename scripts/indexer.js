import axios from 'axios'
import { Project, SyntaxKind, Node } from 'ts-morph'
import { createClient } from '@supabase/supabase-js'
import * as crypto from 'crypto'

// ─── ENV ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const GITHUB_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT
const REPO = process.env.CODER_REPOSITORY
const REPO_ID = parseInt(process.env.REPO_ID, 10)
const SOURCE_ROOT = (process.env.SOURCE_ROOT || '').replace(/\/$/, '')

if (!REPO_ID || !REPO || !SUPABASE_URL || !SUPABASE_KEY || !GITHUB_TOKEN) {
  console.error('Missing: SUPABASE_URL, SUPABASE_KEY/SUPABASE_SERVICE_KEY, PAT_TOKEN/GITHUB_PAT, CODER_REPOSITORY, REPO_ID')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { enabled: false } })

// ─── FRAMEWORK DETECTION ───────────────────────────────────────────
let detectedFramework = 'generic'

async function detectFramework() {
  try {
    const branch = await getDefaultBranch()
    const pkgPath = SOURCE_ROOT ? `${SOURCE_ROOT}/package.json` : 'package.json'
    const url = `https://raw.githubusercontent.com/${REPO}/${branch}/${pkgPath}`
    const res = await axios.get(url)
    const pkg = res.data
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    
    if (deps['next']) return 'nextjs'
    if (deps['@nestjs/core'] || deps['@nestjs/common']) return 'nestjs'
    if (deps['vue'] || deps['vue-router'] || deps['nuxt']) return 'vue'
    if (deps['svelte'] || deps['sveltekit']) return 'svelte'
    if (deps['fastify']) return 'fastify'
    if (deps['express']) return 'express'
    if (deps['react']) return 'react'
    if (deps['remix'] || deps['@remix-run']) return 'remix'
    return 'generic'
  } catch {
    return 'generic'
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────
function detectLanguage(filePath) {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript'
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript'
  if (filePath.endsWith('.vue')) return 'vue'
  if (filePath.endsWith('.svelte')) return 'svelte'
  return null
}

function getFileRole(filePath, framework) {
  const relativePath = SOURCE_ROOT ? filePath.replace(`${SOURCE_ROOT}/`, '') : filePath
  const base = relativePath.split('/').pop() || ''
  
  switch (framework) {
    case 'nextjs':
    case 'remix':
      if (base.startsWith('page.')) return 'page'
      if (base.startsWith('layout.')) return 'layout'
      if (base.startsWith('route.')) return 'route'
      if (base.startsWith('middleware.')) return 'middleware'
      if (base.startsWith('loading.')) return 'loading'
      if (base.startsWith('error.')) return 'error'
      if (base.startsWith('template.')) return 'template'
      return 'none'
      
    case 'express':
    case 'fastify':
      if (relativePath.includes('routes') || relativePath.includes('route')) return 'route'
      if (relativePath.includes('middleware')) return 'middleware'
      if (['app.js','app.ts','server.js','server.ts','index.js','index.ts','main.js','main.ts'].includes(base)) return 'entry_point'
      return 'none'
      
    case 'nestjs':
      if (base.includes('.controller.')) return 'controller'
      if (base.includes('.service.')) return 'service'
      if (base.includes('.module.')) return 'module'
      if (base.includes('.guard.')) return 'guard'
      if (base.includes('.interceptor.')) return 'interceptor'
      if (base.includes('.middleware.')) return 'middleware'
      if (base.includes('.dto.')) return 'dto'
      if (base.includes('.entity.')) return 'entity'
      return 'none'
      
    case 'vue':
    case 'nuxt':
      if (base.startsWith('page.')) return 'page'
      if (base.startsWith('layout.')) return 'layout'
      if (base.endsWith('.vue')) return 'component'
      if (relativePath.includes('composables')) return 'composable'
      return 'none'
      
    default:
      return 'none'
  }
}

function isExported(node) {
  if (Node.isVariableDeclaration(node)) {
    const stmt = node.getParentIfKind(SyntaxKind.VariableStatement)
    return stmt ? (stmt.hasExportKeyword() || stmt.isDefaultExport()) : false
  }
  if (Node.isFunctionDeclaration(node)) return node.hasExportKeyword() || node.isDefaultExport()
  if (Node.isClassDeclaration(node)) return node.hasExportKeyword() || node.isDefaultExport()
  if (Node.isInterfaceDeclaration(node)) return node.hasExportKeyword() || node.isDefaultExport()
  if (Node.isTypeAliasDeclaration(node)) return node.hasExportKeyword() || node.isDefaultExport()
  if (Node.isEnumDeclaration(node)) return node.hasExportKeyword() || node.isDefaultExport()
  return false
}

function computeSignature(node) {
  return crypto.createHash('md5').update(node.getText().slice(0, 500)).digest('hex').slice(0, 16)
}

function resolveModule(filePath, specifier, allPaths) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined
  const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1)
  let resolved = (dir + specifier).replace(/\/+/g, '/')
  const candidates = [
    ...['', '.ts', '.tsx', '.js', '.jsx'].map(ext => resolved + ext),
    ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map(idx => resolved + idx)
  ]
  for (const c of candidates) if (allPaths.has(c)) return c
  return undefined
}

// ─── GITHUB ────────────────────────────────────────────────────────
let _defaultBranch = null
async function getDefaultBranch() {
  if (_defaultBranch) return _defaultBranch
  const res = await axios.get(`https://api.github.com/repos/${REPO}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  })
  _defaultBranch = res.data.default_branch
  return _defaultBranch
}

async function getRepoFiles() {
  const branch = await getDefaultBranch()
  const url = `https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  })
  
  let files = res.data.tree.filter(f => f.type === 'blob')
  
  if (SOURCE_ROOT) {
    const prefix = SOURCE_ROOT + '/'
    files = files.filter(f => f.path.startsWith(prefix))
  }
  
  return files
}

async function getFile(filePath) {
  const branch = await getDefaultBranch()
  const url = `https://raw.githubusercontent.com/${REPO}/${branch}/${filePath}`
  const res = await axios.get(url)
  return res.data
}

// ─── UNIVERSAL ANALYZER ────────────────────────────────────────────
function analyzeFile(filePath, code, language, framework) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true, jsx: 2 } })
  const source = project.createSourceFile(filePath, code, { overwrite: true })

  const analysis = {
    imports: [],
    symbols: [],
    localEdges: [],
    routes: [],
    fileRole: getFileRole(filePath, framework),
    framework,
    metadata: {}
  }

  switch (framework) {
    case 'nextjs':
      analysis.metadata.isClientComponent = /^\s*['"]use client['"]/.test(source.getFullText())
      analysis.metadata.isServerComponent = /^\s*['"]use server['"]/.test(source.getFullText())
      break
    case 'express':
    case 'fastify':
      analysis.metadata.isEntryPoint = ['app.js','app.ts','server.js','server.ts','index.js','index.ts'].includes(filePath.split('/').pop())
      break
  }

  // ── Imports ──
  for (const imp of source.getImportDeclarations()) {
    const moduleSpecifier = imp.getModuleSpecifierValue()
    const bindings = []
    const defaultImport = imp.getDefaultImport()
    if (defaultImport) bindings.push({ localName: defaultImport.getText(), importedName: 'default', isDefault: true })
    for (const named of imp.getNamedImports()) bindings.push({ localName: named.getName(), importedName: named.getName(), isDefault: false })
    const ns = imp.getNamespaceImport()
    if (ns) bindings.push({ localName: ns.getText(), importedName: '*', isDefault: false })
    analysis.imports.push({ moduleSpecifier, bindings })
  }

  // ── Symbols ──
  const addSymbol = (node, name, kind, extraMeta = {}) => {
    const exported = isExported(node)
    const pos = source.getLineAndColumnAtPos(node.getStart())
    const sym = { name, kind, exported, startLine: pos.line, startCol: pos.column, signature: computeSignature(node), metadata: { ...analysis.metadata, ...extraMeta } }
    analysis.symbols.push(sym)
    if (exported && node.isDefaultExport?.()) analysis.symbols.push({ ...sym, name: 'default' })
  }

  // Functions
  for (const fn of source.getFunctions()) {
    if (!fn.getName()) continue
    let kind = 'function'
    if (framework === 'nextjs' && analysis.fileRole === 'route' && ['GET','POST','PUT','DELETE','PATCH'].includes(fn.getName())) kind = 'route_handler'
    if (framework === 'nextjs' && analysis.fileRole === 'middleware' && fn.getName() === 'middleware') kind = 'middleware'
    if ((framework === 'react' || framework === 'nextjs') && analysis.metadata.isClientComponent && fn.getName()[0] === fn.getName()[0].toUpperCase()) kind = 'component'
    if ((framework === 'express' || framework === 'fastify') && analysis.fileRole === 'route' && exported) kind = 'route_handler'
    addSymbol(fn, fn.getName(), kind)
  }

  // Classes
  for (const cls of source.getClasses()) {
    if (!cls.getName()) continue
    let kind = 'class'
    if (framework === 'nestjs') {
      for (const dec of cls.getDecorators()) {
        const name = dec.getName()
        if (name === 'Controller') kind = 'controller'
        if (name === 'Injectable') kind = 'service'
        if (name === 'Module') kind = 'module'
        if (name === 'Guard') kind = 'guard'
        if (name === 'Interceptor') kind = 'interceptor'
      }
    }
    addSymbol(cls, cls.getName(), kind)
  }

  // Interfaces & Types
  for (const iface of source.getInterfaces()) if (iface.getName()) addSymbol(iface, iface.getName(), 'interface')
  for (const typeAlias of source.getTypeAliases()) if (typeAlias.getName()) addSymbol(typeAlias, typeAlias.getName(), 'type')

  // Variable declarations
  for (const varStmt of source.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const init = decl.getInitializer()
      let kind = 'variable'
      if (init && (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression))) {
        kind = 'arrow_function'
        if ((framework === 'react' || framework === 'nextjs') && decl.getName()[0] === decl.getName()[0].toUpperCase()) kind = 'component'
        if ((framework === 'react' || framework === 'nextjs') && decl.getName().startsWith('use') && decl.getName().length > 3 && decl.getName()[3] === decl.getName()[3].toUpperCase()) kind = 'hook'
        if ((framework === 'vue' || framework === 'nuxt') && decl.getName().startsWith('use') && filePath.includes('composables')) kind = 'composable'
      }
      addSymbol(decl, decl.getName(), kind)
    }
  }

  // Class methods
  for (const cls of source.getClasses()) {
    const cName = cls.getName() || 'anonymous'
    for (const method of cls.getMethods()) {
      if (!method.getName()) continue
      let kind = 'method'
      if (framework === 'nestjs') {
        for (const dec of method.getDecorators()) {
          const name = dec.getName()
          if (['Get','Post','Put','Delete','Patch','All'].includes(name)) {
            kind = 'route_handler'
            const args = dec.getArguments()
            if (args.length > 0 && Node.isStringLiteral(args[0])) {
              analysis.routes.push({ method: name.toUpperCase(), path: args[0].getLiteralValue() })
            }
          }
        }
      }
      addSymbol(method, `${cName}.${method.getName()}`, kind)
    }
  }

  // ── Edges: Calls + Renders ──
  const containers = []
  for (const fn of source.getFunctions()) if (fn.getName()) containers.push({ node: fn, name: fn.getName() })
  for (const varStmt of source.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const init = decl.getInitializer()
      if (init && (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression))) {
        containers.push({ node: init, name: decl.getName() })
      }
    }
  }

  for (const container of containers) {
    // Calls
    for (const call of container.node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression()
      let calledName = null
      let edgeMeta = {}
      
      if (Node.isIdentifier(expr)) {
        calledName = expr.getText()
      } else if (Node.isPropertyAccessExpression(expr)) {
        calledName = expr.getName()
        const objName = expr.getExpression().getText()
        const nsImport = analysis.imports.find(i => i.bindings.some(b => b.localName === objName && b.importedName === '*'))
        if (nsImport) {
          edgeMeta = { callExpression: expr.getText(), namespaceObject: objName, resolvedModule: nsImport.moduleSpecifier }
          analysis.localEdges.push({ fromSymbolName: container.name, toSymbolName: calledName, edgeType: 'CALLS', metadata: edgeMeta })
          continue
        }
        
        if ((framework === 'express' || framework === 'fastify') && ['get','post','put','delete','patch','use'].includes(calledName)) {
          const args = call.getArguments()
          if (args.length > 0 && (Node.isStringLiteral(args[0]) || Node.isTemplateExpression(args[0]))) {
            const routePath = args[0].getText().replace(/['"`]/g, '')
            analysis.routes.push({ method: calledName.toUpperCase(), path: routePath })
          }
        }
      }
      
      if (calledName) {
        analysis.localEdges.push({ fromSymbolName: container.name, toSymbolName: calledName, edgeType: 'CALLS', metadata: { callExpression: expr.getText() } })
      }
    }

    // Renders (JSX)
    if (framework === 'react' || framework === 'nextjs' || framework === 'remix') {
      for (const jsx of container.node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement).concat(container.node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement))) {
        const tagName = jsx.getTagNameNode().getText()
        if (tagName[0] === tagName[0].toUpperCase()) {
          analysis.localEdges.push({ fromSymbolName: container.name, toSymbolName: tagName, edgeType: 'RENDERS', metadata: { jsxTag: tagName } })
        }
      }
    }
  }

  // ── Heritage ──
  for (const cls of source.getClasses()) {
    const className = cls.getName()
    if (!className) continue
    for (const heritage of cls.getHeritageClauses()) {
      for (const expr of heritage.getExpressions()) {
        const typeName = expr.getExpression().getText()
        const edgeType = heritage.getToken() === SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS'
        analysis.localEdges.push({ fromSymbolName: className, toSymbolName: typeName, edgeType, metadata: {} })
      }
    }
  }

  // ── Express/Fastify regex fallback ──
  if (framework === 'express' || framework === 'fastify') {
    const text = source.getFullText()
    const routeRegex = /(get|post|put|delete|patch)\(['"`](.*?)['"`]/gi
    let match
    while ((match = routeRegex.exec(text)) !== null) {
      const existing = analysis.routes.find(r => r.method === match[1].toUpperCase() && r.path === match[2])
      if (!existing) analysis.routes.push({ method: match[1].toUpperCase(), path: match[2] })
    }
  }

  return analysis
}

// ─── BATCH UPSERT ──────────────────────────────────────────────────
async function batchUpsert(table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`Upsert to ${table} failed: ${error.message}`)
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────
async function run() {
  console.log(`\n🔥 Forge Universal Indexer — ${REPO} (repo_id: ${REPO_ID})`)
  if (SOURCE_ROOT) console.log(`📂 Source root: ${SOURCE_ROOT}`)
  
  detectedFramework = await detectFramework()
  console.log(`🎯 Framework: ${detectedFramework}`)

  const startTime = Date.now()

  const files = await getRepoFiles()
  const targetFiles = files.filter(f => detectLanguage(f.path) !== null)
  console.log(`📁 ${targetFiles.length} source files found`)

  const analyses = new Map()
  const allPaths = new Set(targetFiles.map(f => f.path))

  for (const f of targetFiles) {
    try {
      const code = await getFile(f.path)
      const lang = detectLanguage(f.path)
      analyses.set(f.path, analyzeFile(f.path, code, lang, detectedFramework))
    } catch (err) {
      console.error(`❌ Analyze failed: ${f.path} — ${err.message}`)
    }
  }
  console.log(`🔍 ${analyses.size} files analyzed`)

  // Resolve imports
  for (const [filePath, analysis] of analyses) {
    for (const imp of analysis.imports) imp.resolvedPath = resolveModule(filePath, imp.moduleSpecifier, allPaths)
  }

  // Upsert files
  const fileRows = targetFiles.filter(f => analyses.has(f.path)).map(f => ({
    repo_id: REPO_ID, path: f.path, sha: f.sha, language: detectLanguage(f.path), parsed_at: new Date().toISOString()
  }))
  await batchUpsert('files', fileRows, 'repo_id,path', 500)

  // Fetch file IDs
  const { data: dbFiles } = await supabase.from('files').select('id,path').eq('repo_id', REPO_ID)
  const fileIdMap = new Map()
  const fileIdToPath = new Map()
  for (const f of dbFiles || []) { fileIdMap.set(f.path, f.id); fileIdToPath.set(f.id, f.path) }

  // Prepare symbols
  const symbolRows = []
  for (const [path, analysis] of analyses) {
    const fileId = fileIdMap.get(path)
    symbolRows.push({
      file_id: fileId, name: '__file__', kind: 'variable', exported: false,
      start_line: null, start_col: null, signature: 'file',
      metadata: { fileRole: analysis.fileRole, framework: analysis.framework, ...analysis.metadata }
    })
    for (const sym of analysis.symbols) {
      symbolRows.push({
        file_id: fileId, name: sym.name, kind: sym.kind, exported: sym.exported,
        start_line: sym.startLine, start_col: sym.startCol, signature: sym.signature, metadata: sym.metadata
      })
    }
  }
  await batchUpsert('symbols', symbolRows, 'file_id,name,kind', 500)

  // Fetch symbol IDs
  const allFileIds = [...fileIdMap.values()]
  let dbSymbols = []
  for (let i = 0; i < allFileIds.length; i += 100) {
    const chunk = allFileIds.slice(i, i + 100)
    const { data, error } = await supabase.from('symbols').select('id,file_id,name').in('file_id', chunk)
    if (error) throw error
    dbSymbols.push(...(data || []))
  }

  const symbolIndex = new Map()
  const fileSymbolIdMap = new Map()
  const globalExportedSymbols = new Map()

  for (const s of dbSymbols) {
    const path = fileIdToPath.get(s.file_id)
    if (!path) continue
    if (!symbolIndex.has(path)) symbolIndex.set(path, new Map())
    symbolIndex.get(path).set(s.name, s.id)
    if (s.name === '__file__') fileSymbolIdMap.set(s.file_id, s.id)

    const analysis = analyses.get(path)
    const localSym = analysis?.symbols.find(ls => ls.name === s.name)
    if (localSym?.exported && s.name !== '__file__') {
      if (!globalExportedSymbols.has(s.name)) globalExportedSymbols.set(s.name, { id: s.id, path })
    }
  }

  // Build edges
  const edgesToInsert = []
  for (const [filePath, analysis] of analyses) {
    const fromFileId = fileIdMap.get(filePath)
    const fromFileSymbolId = fileSymbolIdMap.get(fromFileId)
    const fromSymbols = symbolIndex.get(filePath)

    // Import edges
    for (const imp of analysis.imports) {
      if (!imp.resolvedPath) continue
      const targetSymbols = symbolIndex.get(imp.resolvedPath)
      if (!targetSymbols) continue
      for (const binding of imp.bindings) {
        const targetName = binding.isDefault ? 'default' : binding.importedName
        const targetId = targetSymbols.get(targetName)
        if (targetId && fromFileSymbolId) {
          edgesToInsert.push({
            from_symbol_id: fromFileSymbolId, to_symbol_id: targetId, edge_type: 'IMPORTS',
            source_file_id: fromFileId, metadata: { localName: binding.localName, importedName: binding.importedName, moduleSpecifier: imp.moduleSpecifier }
          })
        }
      }
    }

    // Local edges
    for (const edge of analysis.localEdges) {
      const fromSymbolId = edge.fromSymbolName === '__file__' ? fromFileSymbolId : fromSymbols.get(edge.fromSymbolName)
      if (!fromSymbolId) continue

      let toSymbolId = fromSymbols.get(edge.toSymbolName)

      if (!toSymbolId) {
        const matchingImport = analysis.imports.find(i => i.bindings.some(b => b.localName === edge.toSymbolName))
        if (matchingImport && matchingImport.resolvedPath) {
          const targetSymbols = symbolIndex.get(matchingImport.resolvedPath)
          if (targetSymbols) {
            const binding = matchingImport.bindings.find(b => b.localName === edge.toSymbolName)
            const targetName = binding?.isDefault ? 'default' : binding?.importedName
            toSymbolId = targetSymbols.get(targetName)
          }
        }
      }

      if (!toSymbolId && edge.metadata?.namespaceObject) {
        const nsImport = analysis.imports.find(i => i.bindings.some(b => b.localName === edge.metadata.namespaceObject && b.importedName === '*'))
        if (nsImport && nsImport.resolvedPath) toSymbolId = symbolIndex.get(nsImport.resolvedPath)?.get(edge.toSymbolName)
      }

      if (!toSymbolId) {
        const global = globalExportedSymbols.get(edge.toSymbolName)
        if (global) toSymbolId = global.id
      }

      if (toSymbolId) {
        edgesToInsert.push({
          from_symbol_id: fromSymbolId, to_symbol_id: toSymbolId, edge_type: edge.edgeType,
          source_file_id: fromFileId, metadata: edge.metadata || {}
        })
      }
    }
  }

  // Bulk insert edges
  for (let i = 0; i < edgesToInsert.length; i += 1000) {
    const chunk = edgesToInsert.slice(i, i + 1000)
    const { error } = await supabase.from('edges').upsert(chunk, { onConflict: 'from_symbol_id,to_symbol_id,edge_type,source_file_id' })
    if (error) { console.error(`❌ Edge batch failed: ${error.message}`); throw error }
  }
  console.log(`🔗 ${edgesToInsert.length} edges inserted`)

  // Refresh deps
  const { error: rpcErr } = await supabase.rpc('refresh_file_deps', { p_repo_id: REPO_ID })
  if (rpcErr) throw rpcErr

  // Update repo
  const { data: existingSettings } = await supabase.from('repos').select('settings').eq('id', REPO_ID).single()
  const newSettings = { ...(existingSettings?.settings || {}), framework: detectedFramework }
  await supabase.from('repos').update({ last_indexed_at: new Date().toISOString(), settings: newSettings }).eq('id', REPO_ID)

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ Complete in ${duration}s | Files: ${analyses.size} | Symbols: ${symbolRows.length} | Edges: ${edgesToInsert.length} | Framework: ${detectedFramework}`)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
