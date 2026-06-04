export default async function reposRoutes(fastify) {
  const supabase = fastify.supabase

  // Add a new repo
  fastify.post('/repos', async (req, reply) => {
    const { name, url, github_pat, default_branch, owner_id } = req.body

    if (!name || !url || !github_pat || !owner_id) {
      return reply.status(400).send({ error: 'Missing required fields' })
    }

    const { data, error } = await supabase
      .from('repos')
      .insert({ name, url, github_pat, default_branch: default_branch || 'main', owner_id })
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ ok: true, repo: data })
  })

  // List all repos for a user
  fastify.get('/repos/:owner_id', async (req, reply) => {
    const { owner_id } = req.params

    const { data, error } = await supabase
      .from('repos')
      .select('id, name, url, default_branch, created_at')
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ repos: data })
  })
}
