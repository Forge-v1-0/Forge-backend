export async function loadMemory(supabase, repoId, filePaths = []) {
  let query = supabase
    .from('agent_memory')
    .select('type, file_path, summary, created_at')
    .eq('repo_id', repoId)
    .order('created_at', { ascending: false })

  // If we know which files are involved, only load memory for those files
  // plus any global preferences (file_path is null)
  if (filePaths.length > 0) {
    const formattedPaths = filePaths.map(p => `"${p}"`).join(',')
    query = query.or(`file_path.in.(${formattedPaths}),file_path.is.null`)
  }

  const { data, error } = await query.limit(20)

  if (error) throw new Error(`Failed to load memory: ${error.message}`)
  if (!data || data.length === 0) return 'No past decisions on this repo yet.'

  return data
    .map(m => `[${m.type}] ${m.file_path ? m.file_path + ' — ' : ''}${m.summary}`)
    .join('\n')
}

export async function writeMemory(supabase, {
  repoId,
  sessionId,
  type,
  filePath,
  summary,
  detail = {}
}) {
  const { error } = await supabase
    .from('agent_memory')
    .insert({
      repo_id: repoId,
      session_id: sessionId,
      type,
      file_path: filePath,
      summary,
      detail
    })

  if (error) throw new Error(`Failed to write memory: ${error.message}`)
}
