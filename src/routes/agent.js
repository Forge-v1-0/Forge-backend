export default async function agentRoutes(fastify) {
  const supabase = fastify.supabase

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Start a new agent session — Phase 4 will fill this out fully
  fastify.post('/agent/start', async (req, reply) => {
    const { repo_id, task } = req.body

    if (!repo_id || !task) {
      return reply.status(400).send({ error: 'Missing repo_id or task' })
    }

    const { data: session, error } = await supabase
      .from('sessions')
      .insert({ repo_id, task, status: 'planning' })
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ ok: true, session_id: session.id })
  })

  // Get session status
  fastify.get('/agent/session/:id', async (req, reply) => {
    const { id } = req.params

    const { data, error } = await supabase
      .from('sessions')
      .select(`
        *,
        tasks(*),
        code_drafts(*)
      `)
      .eq('id', id)
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ session: data })
  })
}
