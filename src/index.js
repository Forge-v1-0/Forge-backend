import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createClient } from '@supabase/supabase-js'
import agentRoutes from './routes/agent.js'
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

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || '*'
})

fastify.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health') return

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

const port = process.env.PORT || 3000

try {
  await fastify.listen({ port, host: '0.0.0.0' })
  console.log(`Agent server running on port ${port}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
