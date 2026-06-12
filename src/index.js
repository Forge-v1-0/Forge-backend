import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from './services/crypto.js'
import agentRoutes, { runAgentLoop, runCoderLoop } from './routes/agent.js'
import reposRoutes from './routes/repos.js'
import settingsRoutes from './routes/settings.js'

// ─── STARTUP ENV VALIDATION ─────────────────────────────────────
// crypto.js validates ENCRYPTION_KEY. Validate everything else here
// so the process dies at startup rather than on first request.
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'FRONTEND_URL']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} env var is not set.`)
    process.exit(1)
  }
}

const fastify = Fastify({ logger: true })

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
})
const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
})

fastify.decorate('supabase', supabase)

// ─── DEAD MODEL MAP ─────────────────────────────────────────────
// Kept here for startup-time recovery (recoverStuckSessions reads plan.plannerModel).
// The agent route also has its own sanitizeModel; keep both in sync.
const DEAD_MODELS = {
  'anthropic/claude-3.5-sonnet': 'meta-llama/llama-4-maverick:free',
  'deepseek/deepseek-r1:free': 'meta-llama/llama-4-maverick:free',
  'poolside/laguna-m.1:free': 'meta-llama/llama-4-maverick:free'
}

function sanitizeModel(model) {
  if (!model || typeof model !== 'string') return 'meta-llama/llama-4-maverick:free'
  return DEAD_MODELS[model] || model
}

// ─── GET USER LLM CONFIG ────────────────────────────────────────
fastify.decorate('getUserLLMConfig', async (owner_id) => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('openrouter_api_key, planner_model, coder_model')
    .eq('owner_id', owner_id)
    .maybeSingle()

  if (error) throw new Error(`getUserLLMConfig DB error: ${error.message}`)
  if (!data) throw new Error('No settings found. Please add your OpenRouter API key in settings.')
  if (!data.openrouter_api_key) throw new Error('OpenRouter API key not set. Please add it in settings.')

  // decrypt throws with a human-readable message if the stored value is malformed
  const apiKey = decrypt(data.openrouter_api_key)

  return {
    apiKey,
    plannerModel: sanitizeModel(data.planner_model),
    coderModel: sanitizeModel(data.coder_model)
  }
})

// ─── GET REPO PAT ───────────────────────────────────────────────
// Single authoritative definition — repos.js no longer registers a second
// decorator for this. Centralising here prevents the "last-one-wins" bug.
fastify.decorate('getRepoPat', async function (repoId) {
  if (!repoId) throw new Error('getRepoPat: repoId is required')

  const { data, error } = await supabase
    .from('repos')
    .select('name, url, github_pat')
    .eq('id', repoId)
    .maybeSingle()

  if (error) throw new Error(`getRepoPat DB error: ${error.message}`)
  if (!data) throw new Error(`Repo not found for repoId ${repoId}`)
  if (!data.github_pat) throw new Error(`No github_pat stored for repoId ${repoId}. Please re-add the repo.`)

  // decrypt throws with a human-readable message if the stored value is malformed
  const pat = decrypt(data.github_pat)

  // Derive "owner/repo" from URL — more reliable than storing the repo slug separately
  let repo = data.name
  try {
    const url = new URL(data.url)
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    if (path.includes('/')) repo = path
  } catch {
    // Malformed URL — fall back to raw name
  }

  return { pat, repo }
})

// ─── CORS ───────────────────────────────────────────────────────
await fastify.register(cors, {
  origin: process.env.FRONTEND_URL
})

// ─── AUTH HOOK ──────────────────────────────────────────────────
fastify.addHook('preHandler', async (req, reply) => {
  if (req.routerPath === '/health') return

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or malformed Authorization header' })
  }

  const token = authHeader.slice(7)
  const { data, error } = await supabaseAuth.auth.getUser(token)
  if (error || !data?.user) {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
  req.user = data.user
})

await fastify.register(agentRoutes)
await fastify.register(reposRoutes)
await fastify.register(settingsRoutes)

// ─── STARTUP RECOVERY ───────────────────────────────────────────
// Recovers sessions that were in-flight when the server last crashed.
// Uses the same CAS guard inside runAgentLoop/runCoderLoop to prevent
// duplicate execution if a session was already being processed.
async function recoverStuckSessions() {
  try {
    const { data: stuckSessions } = await supabase
      .from('sessions')
      .select('*, repos(owner_id)')
      .in('status', ['planning', 'coding'])

    if (!stuckSessions || stuckSessions.length === 0) {
      console.log('Startup recovery: no stuck sessions')
      return
    }

    console.log(`Startup recovery: recovering ${stuckSessions.length} stuck session(s)`)

    for (const session of stuckSessions) {
      const ownerId = session.repos?.owner_id
      if (!ownerId) {
        console.warn(`Recovery: session ${session.id} has no owner — skipping`)
        continue
      }

      if (session.status === 'planning') {
        runAgentLoop({
          fastify,
          supabase,
          sessionId: session.id,
          repoId: session.repo_id,
          ownerId,
          task: session.task
        }).catch(err => console.error(`Recovery failed for planning session ${session.id}:`, err.message))
      } else if (session.status === 'coding') {
        runCoderLoop({
          fastify,
          supabase,
          sessionId: session.id,
          repoId: session.repo_id,
          ownerId
        }).catch(err => console.error(`Recovery failed for coding session ${session.id}:`, err.message))
      }
    }
  } catch (err) {
    console.error('Startup recovery failed:', err.message)
  }
}

// ─── START ──────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3000', 10)
try {
  await fastify.listen({ port, host: '0.0.0.0' })
  console.log(`Forge backend running on port ${port}`)
  recoverStuckSessions()
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
