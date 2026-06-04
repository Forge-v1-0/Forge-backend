import Fastify from 'fastify'
import cors from '@fastify/cors'
import supabase from './services/supabase.js'
import agentRoutes from './routes/agent.js'
import reposRoutes from './routes/repos.js'

const fastify = Fastify({ logger: true })

// Attach supabase to fastify instance so routes can access it
fastify.decorate('supabase', supabase)

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || '*'
})

await fastify.register(agentRoutes)
await fastify.register(reposRoutes)

const port = process.env.PORT || 3000

try {
  await fastify.listen({ port, host: '0.0.0.0' })
  console.log(`Agent server running on port ${port}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
