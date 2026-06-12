// context.js
// Builds a dense repo graph string for the planner.

export async function buildContext(supabase, repoId) {
  if (!repoId) throw new Error('buildContext: repoId is required')

  const { data: files, error: fErr } = await supabase
    .from('files')
    .select('id, path, language, symbols!inner(name, kind, exported, metadata)')
    .eq('repo_id', repoId)
    .eq('symbols.name', '__file__')

  if (fErr) throw new Error(`buildContext: failed to load files: ${fErr.message}`)
  if (!files?.length) return 'No indexed files found for this repo. Please trigger a re-index.'

  const fileMap = new Map()
  for (const f of files) {
    const meta = f.symbols?.[0]?.metadata || {}
    fileMap.set(f.path, {
      id: f.id,
      path: f.path,
      language: f.language,
      role: meta.fileRole || 'none',
      framework: meta.framework || 'generic',
      isClient: meta.isClientComponent || false,
      isServer: meta.isServerComponent || false
    })
  }

  const allFileIds = [...fileMap.values()].map(f => f.id)
  const fileIdToPath = new Map([...fileMap.entries()].map(([p, info]) => [info.id, p]))

  // ─── EXPORTED SYMBOLS ──────────────────────────────────────────
  const { data: exportsData, error: exErr } = await supabase
    .from('symbols')
    .select('name, kind, file_id, metadata')
    .eq('exported', true)
    .neq('name', '__file__')
    .in('file_id', allFileIds)

  if (exErr) throw new Error(`buildContext: failed to load symbols: ${exErr.message}`)

  const exportsByFile = new Map()
  for (const ex of exportsData || []) {
    if (!exportsByFile.has(ex.file_id)) exportsByFile.set(ex.file_id, [])
    exportsByFile.get(ex.file_id).push({ name: ex.name, kind: ex.kind, metadata: ex.metadata })
  }

  // ─── RENDER TREE ───────────────────────────────────────────────
  // Filter on source_file_id (not a join field) — using `in` on `source_file_id`
  // is the correct column. The original code queried `edge.source_file_id` 
  // inside a joined select which silently returned empty results.
  const { data: renders } = await supabase
    .from('edges')
    .select('source_file_id, from:from_symbol_id(name, file_id), to:to_symbol_id(name, file_id)')
    .eq('edge_type', 'RENDERS')
    .in('source_file_id', allFileIds)

  const renderTree = new Map()
  for (const e of renders || []) {
    const fromPath = fileIdToPath.get(e.from?.file_id)
    const toName = e.to?.name
    if (!fromPath || !toName) continue
    if (!renderTree.has(fromPath)) renderTree.set(fromPath, [])
    if (!renderTree.get(fromPath).includes(toName)) renderTree.get(fromPath).push(toName)
  }

  // ─── ROUTES & MIDDLEWARE ───────────────────────────────────────
  const { data: routes } = await supabase
    .from('symbols')
    .select('name, kind, file_id, metadata')
    .in('kind', ['route_handler', 'middleware'])
    .in('file_id', allFileIds)

  // ─── IMPORT DEPENDENCIES ───────────────────────────────────────
  const { data: imports } = await supabase
    .from('edges')
    .select('source_file_id, to:to_symbol_id(name, file_id), metadata')
    .eq('edge_type', 'IMPORTS')
    .in('source_file_id', allFileIds)

  const depsByFile = new Map()
  for (const e of imports || []) {
    const fromPath = fileIdToPath.get(e.source_file_id)
    const toPath = e.to?.file_id ? fileIdToPath.get(e.to.file_id) : null
    if (!fromPath || !toPath || fromPath === toPath) continue
    if (!depsByFile.has(fromPath)) depsByFile.set(fromPath, [])
    if (!depsByFile.get(fromPath).includes(toPath)) depsByFile.get(fromPath).push(toPath)
  }

  // ─── FORMAT ────────────────────────────────────────────────────
  const lines = []
  lines.push(`# REPO GRAPH: ${fileMap.size} files indexed\n`)

  lines.push('## Structure')
  const dirs = new Map()
  for (const [path, info] of fileMap) {
    const dir = path.substring(0, path.lastIndexOf('/')) || 'root'
    if (!dirs.has(dir)) dirs.set(dir, [])
    const tags = []
    if (info.role !== 'none') tags.push(info.role)
    if (info.isClient) tags.push('client')
    if (info.isServer) tags.push('server')
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
    const exps = exportsByFile.get(info.id) || []
    const expStr = exps.length ? ` — ${exps.map(e => e.name).join(', ')}` : ''
    dirs.get(dir).push(`  ${path}${tagStr}${expStr}`)
  }
  for (const [dir, items] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir}/`)
    for (const item of items.sort()) lines.push(item)
  }

  if (renderTree.size) {
    lines.push('\n## Component Render Tree')
    for (const [fromPath, children] of [...renderTree.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${fromPath} → [${children.join(', ')}]`)
    }
  }

  if (routes?.length) {
    lines.push('\n## API Surface')
    for (const r of routes) {
      const path = fileIdToPath.get(r.file_id)
      if (!path) continue
      const routeMeta = r.metadata?.route ? ` ${r.metadata.route}` : ''
      lines.push(`  ${r.kind === 'middleware' ? 'MIDDLEWARE' : r.name}${routeMeta} — ${path}`)
    }
  }

  const allExports = exportsData || []

  const components = allExports.filter(e => e.kind === 'component')
  if (components.length) {
    lines.push('\n## Component API Surface')
    for (const c of components) {
      const path = fileIdToPath.get(c.file_id)
      if (!path) continue
      const props = c.metadata?.props
      const propStr = props?.length ? `{${props.map(p => `${p.name}${p.required ? '' : '?'}`).join(', ')}}` : ''
      lines.push(`  ${c.name} (${path}) ${propStr}`)
    }
  }

  const hooks = allExports.filter(e => e.kind === 'hook')
  if (hooks.length) {
    lines.push('\n## Hook API Surface')
    for (const h of hooks) {
      const path = fileIdToPath.get(h.file_id)
      if (!path) continue
      const params = h.metadata?.props
      const paramStr = params?.length ? `(${params.map(p => `${p.name}${p.required ? '' : '?'}`).join(', ')})` : '()'
      lines.push(`  ${h.name} (${path}) ${paramStr}`)
    }
  }

  // The original filter was broken: it excluded 'component' and 'hook' from the
  // `kind` array but also included them in the outer filter — always returning
  // an empty array. Fixed: filter on kinds that are NOT component or hook.
  const fnKinds = new Set(['function', 'arrow_function', 'method', 'service', 'controller', 'route_handler'])
  const functions = allExports.filter(e => fnKinds.has(e.kind))
  if (functions.length) {
    lines.push('\n## Function API Surface')
    for (const f of functions.slice(0, 20)) {
      const path = fileIdToPath.get(f.file_id)
      if (!path) continue
      const params = f.metadata?.props
      const paramStr = params?.length ? `(${params.map(p => `${p.name}${p.required ? '' : '?'}`).join(', ')})` : '()'
      lines.push(`  ${f.name} (${path}) ${paramStr}`)
    }
    if (functions.length > 20) lines.push(`  … and ${functions.length - 20} more`)
  }

  return lines.join('\n')
}

export async function getFileLanguage(supabase, repoId, filePath) {
  if (!repoId || !filePath) return 'typescript'
  const { data, error } = await supabase
    .from('files')
    .select('language')
    .eq('repo_id', repoId)
    .eq('path', filePath)
    .maybeSingle()

  if (error || !data) return 'typescript'
  return data.language || 'typescript'
}

export async function getImpactedFiles(supabase, repoId, symbolName, depth = 3) {
  if (!repoId || !symbolName) return []
  const { data, error } = await supabase.rpc('get_impacted_files', {
    p_symbol_name: symbolName,
    p_repo_id: repoId,
    p_depth: depth
  })
  if (error) {
    console.error('get_impacted_files error:', error.message)
    return []
  }
  return data || []
}
