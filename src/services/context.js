export async function buildContext(supabase, repoId) {
  const { data: files, error: fErr } = await supabase
    .from('files')
    .select('id, path, language, symbols!inner(name, kind, exported, metadata)')
    .eq('repo_id', repoId)
    .eq('symbols.name', '__file__')

  if (fErr || !files?.length) return 'No indexed files found for this repo.'

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

  const fileIdToPath = new Map([...fileMap.entries()].map(([p, info]) => [info.id, p]))

  // Exported symbols
  const { data: exports } = await supabase
    .from('symbols')
    .select('name, kind, file_id, metadata')
    .eq('exported', true)
    .neq('name', '__file__')
    .in('file_id', [...fileMap.values()].map(f => f.id))

  const exportsByFile = new Map()
  for (const ex of exports || []) {
    if (!exportsByFile.has(ex.file_id)) exportsByFile.set(ex.file_id, [])
    exportsByFile.get(ex.file_id).push({ name: ex.name, kind: ex.kind, metadata: ex.metadata })
  }

  // Render tree
  const { data: renders } = await supabase
    .from('edges')
    .select('from_symbol_id, to_symbol_id, from:from_symbol_id(name, file_id), to:to_symbol_id(name, file_id)')
    .eq('edge_type', 'RENDERS')
    .in('source_file_id', [...fileMap.values()].map(f => f.id))

  const renderTree = new Map()
  for (const e of renders || []) {
    const fromPath = fileIdToPath.get(e.from.file_id)
    const toName = e.to.name
    if (!fromPath) continue
    if (!renderTree.has(fromPath)) renderTree.set(fromPath, [])
    if (!renderTree.get(fromPath).includes(toName)) renderTree.get(fromPath).push(toName)
  }

  // Routes & middleware
  const { data: routes } = await supabase
    .from('symbols')
    .select('name, kind, file_id, metadata')
    .in('kind', ['route_handler', 'middleware'])
    .in('file_id', [...fileMap.values()].map(f => f.id))

  // Import dependencies
  const { data: imports } = await supabase
    .from('edges')
    .select('source_file_id, to_symbol_id, to:to_symbol_id(name, file_id), metadata')
    .eq('edge_type', 'IMPORTS')
    .in('source_file_id', [...fileMap.values()].map(f => f.id))

  const depsByFile = new Map()
  for (const e of imports || []) {
    const fromPath = fileIdToPath.get(e.source_file_id)
    const toPath = fileIdToPath.get(e.to.file_id)
    if (!fromPath || !toPath) continue
    if (!depsByFile.has(fromPath)) depsByFile.set(fromPath, [])
    if (!depsByFile.get(fromPath).includes(toPath)) depsByFile.get(fromPath).push(toPath)
  }

  // ─── FORMAT DENSE CONTEXT ────────────────────────────────────────
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
      lines.push(`  ${r.kind === 'middleware' ? 'MIDDLEWARE' : r.name} — ${path}`)
    }
  }

  // ─── DESIGN SYSTEM SURFACE WITH PROPS ──────────────────────────────
  const uiFiles = [...fileMap.entries()].filter(([p]) => p.includes('/components/ui/') || p.includes('/components/'))
  if (uiFiles.length) {
    lines.push('\n## Design System Surface')
    for (const [path, info] of uiFiles) {
      const exps = exportsByFile.get(info.id) || []
      for (const exp of exps) {
        if (['component', 'function', 'arrow_function'].includes(exp.kind)) {
          const props = exp.metadata?.props
          const propStr = props && props.length 
            ? `{${props.map(p => `${p.name}${p.required ? '' : '?'}`).join(', ')}}`
            : ''
          lines.push(`  ${exp.name} (${path}) ${propStr}`)
        }
      }
    }
  }

  if (depsByFile.size) {
    lines.push('\n## File Dependencies')
    for (const [fromPath, toPaths] of [...depsByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${fromPath} → ${toPaths.map(p => p.split('/').pop()).join(', ')}`)
    }
  }

  const highRiskPaths = [...fileMap.values()]
    .filter(f => f.role === 'middleware' || f.path.includes('supabase') || f.path.includes('auth') || f.path.includes('crypto'))
    .map(f => f.path)
  if (highRiskPaths.length) {
    lines.push('\n## High-Risk Symbols (Auth, Database, Crypto)')
    for (const p of highRiskPaths) lines.push(`  ⚠️ ${p}`)
  }

  return lines.join('\n')
}

export async function getFileLanguage(supabase, repoId, filePath) {
  const { data, error } = await supabase
    .from('files')
    .select('language')
    .eq('repo_id', repoId)
    .eq('path', filePath)
    .single()

  if (error || !data) return 'typescript'
  return data.language
}

export async function getImpactedFiles(supabase, repoId, symbolName, depth = 3) {
  const { data, error } = await supabase
    .rpc('get_impacted_files', { p_symbol_name: symbolName, p_repo_id: repoId, p_depth: depth })

  if (error) {
    console.error('get_impacted_files error:', error.message)
    return []
  }
  return data || []
}
