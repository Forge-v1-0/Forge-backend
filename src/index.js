import Fastify from 'fastify'
import cors from '@fastify/cors'
import supabase from './services/supabase.js'
import agentRoutes from './routes/agent.js'
import reposRoutes from './routes/repos.js'
import settingsRoutes from './routes/settings.js'

const fastify = Fastify({ logger: true })

fastify.decorate('supabase', supabase)

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || '*'
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
