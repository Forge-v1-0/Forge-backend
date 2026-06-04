export async function loadMemory(supabase, repoId) {
  const { data, error } = await supabase
    .from('agent_memory')
    .select('type, file_path, summary, created_at')
    .eq('repo_id', repoId)
    .order('created_at', { ascending: false })
    .limit(20)

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
