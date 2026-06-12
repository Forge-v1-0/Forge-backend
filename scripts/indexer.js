import axios from 'axios'
import { Project, SyntaxKind, Node } from 'ts-morph'
import { createClient } from '@supabase/supabase-js'
import * as crypto from 'crypto'

// ─── ENV VALIDATION ────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const GITHUB_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT
const REPO = process.env.CODER_REPOSITORY
const REPO_ID = parseInt(process.env.REPO_ID, 10)
const SOURCE_ROOT = (process.env.SOURCE_ROOT || '').replace(/\/$/, '')

if (!REPO_ID || isNaN(REPO_ID) || !REPO || !SUPABASE_URL || !SUPABASE_KEY || !GITHUB_TOKEN) {
  console.error('FATAL: Missing required env vars: SUPABASE_URL, SUPABASE_KEY, PAT_TOKEN, CODER_REPOSITORY, REPO_ID')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
const GH_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}

// ─── FRAMEWORK DETECTION ──────────────────────────────────────────
let detectedFramework = 'generic'

async function detectFramework() {
  try {
    const branch = await getDefaultBranch()
    // Use the authenticated GitHub Contents API instead of raw.githubusercontent.com,
    // which does not accept Authorization headers and returns 404 on private repos.
    const pkgPath = SOURCE_ROOT ? `${SOURCE_ROOT}/package.json` : 'package.json'
    const res = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${pkgPath}?ref=${branch}`,
      { headers: GH_HEADERS }
    )
    // Contents API returns content as base64
    const pkg = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'))
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }

    if (deps['next']) return 'nextjs'
    if (deps['@nestjs/core'] || deps['@nestjs/common']) return 'nestjs'
    if (deps['nuxt']) return 'nuxt'
    if (deps['vue'] || deps['vue-router']) return 'vue'
    if (deps['svelte'] || deps['@sveltejs/kit']) return 'svelte'
    if (deps['fastify']) return 'fastify'
    if (deps['express']) return 'express'
    if (deps['@remix-run/node'] || deps['@remix-run/react']) return 'remix'
    if (deps['react']) return 'react'
    return 'generic'
  } catch (err) {
    console.warn(`Framework detection failed (${err.message}), defaulting to 'generic'`)
    return 'generic'
  }
}

// ─── GITHUB HELPERS ───────────────────────────────────────────────
let _defaultBranch = null
async function getDefaultBranch() {
  if (_defaultBranch) return _defaultBranch
  const res = await axios.get(`https://api.github.com/repos/${REPO}`, { headers: GH_HEADERS })
  _defaultBranch = res.data.default_branch
  if (!_defaultBranch) throw new Error('GitHub repo response missing default_branch')
  return _defaultBranch
}

async function getRepoFiles() {
  const branch = await getDefaultBranch()
  const res = await axios.get(
    `https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`,
    { headers: GH_HEADERS }
  )

  // GitHub silently truncates trees with > 100,000 entries.
  // We must detect this and fail rather than index a partial graph.
  if (res.data.truncated) {
    if (!SOURCE_ROOT) {
      throw new Error(
        'GitHub tree response was truncated (repo exceeds 100,000 entries). ' +
        'Set SOURCE_ROOT to a subdirectory and re-trigger indexing.'
      )
    }
    // With SOURCE_ROOT set we filter to a subtree so truncation shouldn't
    // be an issue for typical repos, but warn in case it still happens.
    console.warn('WARNING: GitHub tree response was truncated. Index may be incomplete. Consider a narrower SOURCE_ROOT.')
  }

  let files = res.data.tree.filter(f => f.type === 'blob')

  if (SOURCE_ROOT) {
    const prefix = SOURCE_ROOT + '/'
    files = files.filter(f => f.path.startsWith(prefix))
    if (files.length === 0) {
      throw new Error(`SOURCE_ROOT '${SOURCE_ROOT}' matched no files in the repo tree. Check the path.`)
    }
  }

  return files
}

async function getFile(filePath) {
  const branch = await getDefaultBranch()
  // Use Contents API (authenticated) for private repos
  const res = await axios.get(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${branch}`,
    { headers: GH_HEADERS }
  )
  if (!res.data.content) throw new Error(`Contents API response for ${filePath} missing content field`)
  return Buffer.from(res.data.content, 'base64').toString('utf8')
}

// ─── LANGUAGE + ROLE DETECTION ───────────────────────────────────
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

// ─── AST HELPERS ─────────────────────────────────────────────────
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

function extractProps(node) {
  const params = node.getParameters()
  if (params.length === 0) return null
  const firstParam = params[0]
  if (Node.isObjectBindingPattern(firstParam)) {
    return firstParam.getElements().map(el => {
      const hasDefault = !!el.getInitializer()
      return { name: el.getName(), required: !hasDefault, hasDefault }
    })
  }
  if (Node.isIdentifier(firstParam)) {
    return [{ name: firstParam.getText(), required: false, isPropsObject: true }]
  }
  return null
}

function resolveModule(filePath, specifier, allPaths) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return undefined
  const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1)
  const resolved = (dir + specifier).replace(/\/+/g, '/')
  const candidates = [
    ...['', '.ts', '.tsx', '.js', '.jsx'].map(ext => resolved + ext),
    ...['/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map(idx => resolved + idx)
  ]
  for (const c of candidates) if (allPaths.has(c)) return c
  return undefined
}

// ─── FILE ANALYZER ───────────────────────────────────────────────
// Creates a single shared ts-morph Project and reuses it across all files
// to avoid the O(n) per-file project instantiation overhead.
function createAnalyzer() {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 2, skipLibCheck: true }
  })

  return function analyzeFile(filePath, code, language, framework) {
    // Overwrite the in-memory file (no accumulation across files)
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

    for (const fn of source.getFunctions()) {
      if (!fn.getName()) continue
      let kind = 'function'
      let props = null
      if (framework === 'nextjs' && analysis.fileRole === 'route' && ['GET','POST','PUT','DELETE','PATCH'].includes(fn.getName())) kind = 'route_handler'
      if (framework === 'nextjs' && analysis.fileRole === 'middleware' && fn.getName() === 'middleware') kind = 'middleware'
      if ((framework === 'react' || framework === 'nextjs') && analysis.metadata.isClientComponent && fn.getName()[0] === fn.getName()[0].toUpperCase()) {
        kind = 'component'
        props = extractProps(fn)
      }
      if ((framework === 'express' || framework === 'fastify') && analysis.fileRole === 'route' && fn.hasExportKeyword()) kind = 'route_handler'
      addSymbol(fn, fn.getName(), kind, { props })
    }

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

    for (const iface of source.getInterfaces()) if (iface.getName()) addSymbol(iface, iface.getName(), 'interface')
    for (const typeAlias of source.getTypeAliases()) if (typeAlias.getName()) addSymbol(typeAlias, typeAlias.getName(), 'type')

    for (const varStmt of source.getVariableStatements()) {
      for (const decl of varStmt.getDeclarations()) {
        const init = decl.getInitializer()
        let kind = 'variable'
        let props = null
        if (init && (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression))) {
          kind = 'arrow_function'
          if ((framework === 'react' || framework === 'nextjs') && decl.getName()[0] === decl.getName()[0].toUpperCase()) {
            kind = 'component'
            props = extractProps(init)
          }
          if ((framework === 'react' || framework === 'nextjs') && decl.getName().startsWith('use') && decl.getName().length > 3 && decl.getName()[3] === decl.getName()[3].toUpperCase()) kind = 'hook'
          if ((framework === 'vue' || framework === 'nuxt') && decl.getName().startsWith('use') && filePath.includes('composables')) kind = 'composable'
        }
        addSymbol(decl, decl.getName(), kind, { props })
      }
    }

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

    // ── Edges ──
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

      if (framework === 'react' || framework === 'nextjs' || framework === 'remix') {
        for (const jsx of container.node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement).concat(container.node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement))) {
          const tagName = jsx.getTagNameNode().getText()
          if (tagName[0] === tagName[0].toUpperCase()) {
            analysis.localEdges.push({ fromSymbolName: container.name, toSymbolName: tagName, edgeType: 'RENDERS', metadata: { jsxTag: tagName } })
          }
        }
      }
    }

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
}

// ─── BATCH UPSERT ─────────────────────────────────────────────────
async function batchUpsert(table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`Upsert to '${table}' failed: ${error.message}`)
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────
async function run() {
  console.log(`\n🔥 Forge Universal Indexer — ${REPO} (repo_id: ${REPO_ID})`)
  if (SOURCE_ROOT) console.log(`📂 Source root: ${SOURCE_ROOT}`)

  // Mark as indexing at the start so the frontend can show progress
  await supabase.from('repos').update({ index_status: 'indexing' }).eq('id', REPO_ID)

  detectedFramework = await detectFramework()
  console.log(`🎯 Framework: ${detectedFramework}`)

  const startTime = Date.now()
  const files = await getRepoFiles()
  const targetFiles = files.filter(f => detectLanguage(f.path) !== null)
  console.log(`📁 ${targetFiles.length} source files found`)

  if (targetFiles.length === 0) {
    throw new Error(`No JS/TS/Vue/Svelte files found in ${SOURCE_ROOT || 'repo root'}. Check SOURCE_ROOT.`)
  }

  const analyzeFile = createAnalyzer()
  const analyses = new Map()
  const allPaths = new Set(targetFiles.map(f => f.path))

  for (const f of targetFiles) {
    try {
      const code = await getFile(f.path)
      const lang = detectLanguage(f.path)
      analyses.set(f.path, analyzeFile(f.path, code, lang, detectedFramework))
    } catch (err) {
      console.error(`❌ Analyze failed: ${f.path} — ${err.message}`)
      // Continue — one bad file should not abort the whole index
    }
  }
  console.log(`🔍 ${analyses.size} files analyzed (${targetFiles.length - analyses.size} failed)`)

  // Resolve imports
  for (const [filePath, analysis] of analyses) {
    for (const imp of analysis.imports) imp.resolvedPath = resolveModule(filePath, imp.moduleSpecifier, allPaths)
  }

  // ── Upsert files ──
  const fileRows = [...analyses.keys()].map(path => {
    const f = targetFiles.find(t => t.path === path)
    return { repo_id: REPO_ID, path, sha: f?.sha || null, language: detectLanguage(path), parsed_at: new Date().toISOString() }
  })
  await batchUpsert('files', fileRows, 'repo_id,path', 500)

  // ── Fetch file IDs ──
  const { data: dbFiles, error: dbFilesErr } = await supabase.from('files').select('id,path').eq('repo_id', REPO_ID)
  if (dbFilesErr) throw new Error(`Failed to fetch file IDs: ${dbFilesErr.message}`)
  const fileIdMap = new Map()
  const fileIdToPath = new Map()
  for (const f of dbFiles || []) { fileIdMap.set(f.path, f.id); fileIdToPath.set(f.id, f.path) }

  // ── Prepare symbols ──
  const symbolRows = []
  for (const [path, analysis] of analyses) {
    const fileId = fileIdMap.get(path)
    if (!fileId) continue
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

  // ── Fetch symbol IDs ──
  const allFileIds = [...fileIdMap.values()]
  let dbSymbols = []
  for (let i = 0; i < allFileIds.length; i += 100) {
    const chunk = allFileIds.slice(i, i + 100)
    const { data, error } = await supabase.from('symbols').select('id,file_id,name').in('file_id', chunk)
    if (error) throw new Error(`Failed to fetch symbol IDs: ${error.message}`)
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

  // ── Build edges ──
  const edgesToInsert = []
  for (const [filePath, analysis] of analyses) {
    const fromFileId = fileIdMap.get(filePath)
    const fromFileSymbolId = fileSymbolIdMap.get(fromFileId)
    const fromSymbols = symbolIndex.get(filePath)

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

    for (const edge of analysis.localEdges) {
      const fromSymbolId = edge.fromSymbolName === '__file__' ? fromFileSymbolId : fromSymbols?.get(edge.fromSymbolName)
      if (!fromSymbolId) continue

      let toSymbolId = fromSymbols?.get(edge.toSymbolName)

      if (!toSymbolId) {
        const matchingImport = analysis.imports.find(i => i.bindings.some(b => b.localName === edge.toSymbolName))
        if (matchingImport?.resolvedPath) {
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
        if (nsImport?.resolvedPath) toSymbolId = symbolIndex.get(nsImport.resolvedPath)?.get(edge.toSymbolName)
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

  // Deduplicate edges (PostgreSQL upsert fails on duplicate conflict keys in one batch)
  const edgeKey = e => `${e.from_symbol_id}|${e.to_symbol_id}|${e.edge_type}|${e.source_file_id}`
  const seenEdges = new Set()
  const dedupedEdges = edgesToInsert.filter(e => {
    const key = edgeKey(e)
    if (seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })

  for (let i = 0; i < dedupedEdges.length; i += 1000) {
    const chunk = dedupedEdges.slice(i, i + 1000)
    const { error } = await supabase.from('edges').upsert(chunk, { onConflict: 'from_symbol_id,to_symbol_id,edge_type,source_file_id' })
    if (error) throw new Error(`Edge batch insert failed: ${error.message}`)
  }
  console.log(`🔗 ${dedupedEdges.length} edges (${edgesToInsert.length - dedupedEdges.length} duplicates removed)`)

  // Refresh dependency summary
  const { error: rpcErr } = await supabase.rpc('refresh_file_deps', { p_repo_id: REPO_ID })
  if (rpcErr) throw new Error(`refresh_file_deps failed: ${rpcErr.message}`)

  // Mark as indexed only after every stage succeeds
  const { data: existingSettings } = await supabase.from('repos').select('settings').eq('id', REPO_ID).single()
  const newSettings = { ...(existingSettings?.settings || {}), framework: detectedFramework }
  await supabase.from('repos').update({
    index_status: 'indexed',
    file_count: analyses.size,
    last_indexed_at: new Date().toISOString(),
    settings: newSettings
  }).eq('id', REPO_ID)

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ Complete in ${duration}s | Files: ${analyses.size} | Symbols: ${symbolRows.length} | Edges: ${dedupedEdges.length} | Framework: ${detectedFramework}`)
}

run().catch(async err => {
  console.error('FATAL indexer error:', err.message)
  try {
    await supabase.from('repos').update({
      index_status: 'failed',
      settings: { error: err.message }
    }).eq('id', REPO_ID)
  } catch (e) {
    console.error('Also failed to update repo status:', e.message)
  }
  process.exit(1)
})
