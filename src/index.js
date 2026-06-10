import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from './services/crypto.js'
import agentRoutes, { runAgentLoop, runCoderLoop } from './routes/agent.js'
import reposRoutes from './routes/repos.js'
import settingsRoutes from './routes/settings.js'

const fastify = Fastify({ logger: true })
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

fastify.decorate('supabase', supabase)

// ─── ROOT DECORATOR (available to all routes) ───────────────────────
fastify.decorate('getUserLLMConfig', async (owner_id) => {
  const { data, error } = await fastify.supabase
    .from('user_settings')
    .select('openrouter_api_key, planner_model, coder_model')
    .eq('owner_id', owner_id)
    .single()

  if (error || !data) {
    throw new Error('No settings found. Please add your OpenRouter API key in settings.')
  }

  if (!data.openrouter_api_key) {
    throw new Error('OpenRouter API key not set. Please add it in settings.')
  }

  return {
    apiKey: decrypt(data.openrouter_api_key),
    plannerModel: data.planner_model,
    coderModel: data.coder_model
  }
})

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || '*'
})

fastify.addHook('preHandler', async (req, reply) => {
  if (req.routerPath === '/health') return
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization header' })
  }
  const token = authHeader.replace('Bearer ', '')
  const { data, error } = await supabaseAuth.auth.getUser(token)
  if (error || !data.user) {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
  req.user = data.user
})

await fastify.register(agentRoutes)
await fastify.register(reposRoutes)
await fastify.register(settingsRoutes)

// ─── STARTUP RECOVERY ───────────────────────────────────────────────
async function recoverStuckSessions() {
  try {
    const { data: stuckSessions } = await supabase
      .from('sessions')
      .select('*')
      .in('status', ['planning', 'coding'])

    if (!stuckSessions || stuckSessions.length === 0) return

    console.log(`Recovering ${stuckSessions.length} stuck sessions`)

    for (const session of stuckSessions) {
      const { data: repo } = await supabase
        .from('repos')
        .select('owner_id')
        .eq('id', session.repo_id)
        .single()

      if (!repo) continue

      if (session.status === 'planning') {
        runAgentLoop({
          fastify,
          supabase,
          sessionId: session.id,
          repoId: session.repo_id,
          ownerId: repo.owner_id,
          task: session.task
        }).catch(err => console.error(`Recovery failed for session ${session.id}:`, err.message))
      } else if (session.status === 'coding') {
        runCoderLoop({
          fastify,
          supabase,
          sessionId: session.id,
          repoId: session.repo_id,
          ownerId: repo.owner_id
        }).catch(err => console.error(`Recovery failed for session ${session.id}:`, err.message))
      }
    }
  } catch (err) {
    console.error('Failed to recover stuck sessions:', err.message)
  }
}

const port = process.env.PORT || 3000
try {
  await fastify.listen({ port, host: '0.0.0.0' })
  console.log(`Agent server running on port ${port}`)
  
  // Run recovery after server is up and ready
  recoverStuckSessions()
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
