export async function buildContext(supabase, repoId) {
  const { data, error } = await supabase
    .from('repo_index')
    .select('path, language, data')
    .eq('repo_id', repoId)

  if (error) throw new Error(`Failed to load context: ${error.message}`)
  if (!data || data.length === 0) return 'No files indexed yet for this repo.'

  // Build a compact summary — not full AST, just enough for planner to reason
  const lines = data.map(row => {
    const exports = row.data?.exports?.join(', ') || ''
    const routes = row.data?.routes?.map(r => `${r.method} ${r.path}`).join(', ') || ''
    const functions = row.data?.functions?.map(f => f.name).join(', ') || ''

    let summary = `[${row.language}] ${row.path}`
    if (exports) summary += `\n  exports: ${exports}`
    if (routes) summary += `\n  routes: ${routes}`
    if (functions) summary += `\n  functions: ${functions}`

    return summary
  })

  return lines.join('\n\n')
}
