// memory.js
// Repo-scoped decision memory for the planner and coder.

export async function loadMemory(supabase, repoId, filePaths = []) {
  if (!repoId) throw new Error('loadMemory: repoId is required')

  let query = supabase
    .from('agent_memory')
    .select('type, file_path, summary, created_at')
    .eq('repo_id', repoId)
    .order('created_at', { ascending: false })
    .limit(20)

  if (filePaths.length > 0) {
    // Supabase JS v2 `.or()` requires the PostgREST filter string.
    // Build it explicitly to avoid the broken template-string quoting bug
    // that existed in the original: `file_path.in.("a","b")` uses the wrong
    // quoting — PostgREST needs `file_path.in.(a,b)` with no quotes around
    // string values when using the filter DSL. Use explicit or() chain instead.
    const pathFilter = filePaths.map(p => `file_path.eq.${p}`).join(',')
    query = query.or(`${pathFilter},file_path.is.null`)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to load memory: ${error.message}`)
  if (!data || data.length === 0) return 'No past decisions on this repo yet.'

  return data
    .map(m => `[${m.type}] ${m.file_path ? m.file_path + ' — ' : ''}${m.summary}`)
    .join('\n')
}

export async function writeMemory(supabase, { repoId, sessionId, type, filePath, summary, detail = {} }) {
  if (!repoId || !type || !summary) {
    throw new Error('writeMemory: repoId, type, and summary are required')
  }

  const { error } = await supabase.from('agent_memory').insert({
    repo_id: repoId,
    session_id: sessionId || null,
    type,
    file_path: filePath || null,
    summary,
    detail
  })

  if (error) throw new Error(`Failed to write memory: ${error.message}`)
}
