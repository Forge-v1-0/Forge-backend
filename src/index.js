import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from './services/crypto.js'
import agentRoutes, { runAgentLoop, runCoderLoop } from './routes/agent.js'
import reposRoutes from './routes/repos.js'
import settingsRoutes from './routes/settings.js'

// ─── STARTUP ENV VALIDATION ─────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'FRONTEND_URL', 'ENCRYPTION_KEY']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} env var is not set.`)
    process.exit(1)
  }
}

// ─── FASTIFY SETUP WITH REDACTED LOGGING ────────────────────────
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'warn',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.body.github_pat',
        'req.body.openrouter_api_key',
        'req.body.pat_token'
      ],
      remove: true
    }
  }
})

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
})
const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
})

fastify.decorate('supabase', supabase)

// ─── ACTIVE JOBS TRACKING (for graceful shutdown) ───────────────
const activeJobs = new Map()
fastify.decorate('activeJobs', activeJobs)

function trackJob(id, promise) {
  activeJobs.set(id, promise)
  promise.finally(() => activeJobs.delete(id))
}

// ─── DEAD MODEL MAP ─────────────────────────────────────────────
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

  const apiKey = decrypt(data.openrouter_api_key)

  return {
    apiKey,
    plannerModel: sanitizeModel(data.planner_model),
    coderModel: sanitizeModel(data.coder_model)
  }
})

// ─── GET REPO PAT (with caching) ────────────────────────────────
fastify.decorate('patCache', new Map())

fastify.decorate('getRepoPat', async function (repoId) {
  if (!repoId) throw new Error('getRepoPat: repoId is required')

  const cached = this.patCache.get(repoId)
  if (cached && cached.expires > Date.now()) {
    return cached.value
  }

  const { data, error } = await supabase
    .from('repos')
    .select('name, url, github_pat')
    .eq('id', repoId)
    .maybeSingle()

  if (error) throw new Error(`getRepoPat DB error: ${error.message}`)
  if (!data) throw new Error(`Repo not found for repoId ${repoId}`)
  if (!data.github_pat) throw new Error(`No github_pat stored for repoId ${repoId}. Please re-add the repo.`)

  const pat = decrypt(data.github_pat)

  let repo = data.name
  try {
    const url = new URL(data.url)
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
    if (path.includes('/')) repo = path
  } catch {
    // Malformed URL — fall back to raw name
  }

  const result = { pat, repo }
  this.patCache.set(repoId, { value: result, expires: Date.now() + 300000 }) // 5 min cache
  return result
})

// ─── CORS ───────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(o => o.trim().replace(/\/$/, ''))
  .filter(Boolean)

await fastify.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      cb(null, true)
    } else {
      cb(new Error('Not allowed by CORS'), false)
    }
  },
  credentials: true
})

// ─── RATE LIMITING ──────────────────────────────────────────────
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.user?.id || req.ip,
  errorResponseBuilder: (req, context) => ({
    error: 'Too many requests',
    code: 'RATE_LIMIT',
    retryAfter: context.after
  })
})

// ─── AUTH HOOK ──────────────────────────────────────────────────
fastify.addHook('preHandler', async (req, reply) => {
  if (req.routerPath === '/health') return

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or malformed Authorization header', code: 'UNAUTHORIZED' })
  }

  const token = authHeader.slice(7)
  const { data, error } = await supabaseAuth.auth.getUser(token)
  if (error || !data?.user) {
    return reply.status(401).send({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' })
  }

  // Verify user still exists in database (revocation check)
  const { data: userExists } = await supabase
    .from('auth.users')
    .select('id')
    .eq('id', data.user.id)
    .single()

  if (!userExists) {
    return reply.status(401).send({ error: 'User account no longer exists', code: 'UNAUTHORIZED' })
  }

  req.user = data.user
})

await fastify.register(agentRoutes)
await fastify.register(reposRoutes)
await fastify.register(settingsRoutes)

// ─── HEALTH CHECK (with dependency checks) ──────────────────────
fastify.get('/health', async () => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '2.0.0',
    uptime: process.uptime(),
    database: 'unknown',
    github: 'unknown',
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  }

  try {
    await supabase.from('repos').select('id', { head: true, count: 'exact' })
    checks.database = 'ok'
  } catch (e) { checks.database = 'error' }

  try {
    await fetch('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${process.env.INDEXER_PAT || ''}` }
    })
    checks.github = 'ok'
  } catch (e) { checks.github = 'error' }

  const allOk = checks.database === 'ok' && checks.github === 'ok'
  return { status: allOk ? 'ok' : 'degraded', checks }
})

// ─── MEMORY MONITORING ──────────────────────────────────────────
const MEM_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || '400')
setInterval(() => {
  const used = process.memoryUsage()
  const usedMB = Math.round(used.heapUsed / 1024 / 1024)
  if (usedMB > MEM_LIMIT_MB * 0.8) {
    console.warn(`⚠️ Memory usage high: ${usedMB}MB / ${MEM_LIMIT_MB}MB`)
  }
  if (usedMB > MEM_LIMIT_MB * 0.95) {
    console.error(`🚨 Memory critical: ${usedMB}MB. Exiting for clean restart...`)
    process.exit(1)
  }
}, 30000)

// ─── STARTUP RECOVERY (with distributed lock) ───────────────────
async function recoverStuckSessions() {
  try {
    // Try to acquire advisory lock
    const { data: hasLock } = await supabase.rpc('try_advisory_lock', { key: 'session_recovery' })
    if (!hasLock) {
      console.log('Another instance is handling recovery, skipping')
      return
    }

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

        const jobId = `recovery-${session.id}`
        if (session.status === 'planning') {
          const promise = runAgentLoop({
            fastify, supabase,
            sessionId: session.id,
            repoId: session.repo_id,
            ownerId,
            task: session.task
          }).catch(err => console.error(`Recovery failed for planning session ${session.id}:`, err.message))
          trackJob(jobId, promise)
        } else if (session.status === 'coding') {
          const promise = runCoderLoop({
            fastify, supabase,
            sessionId: session.id,
            repoId: session.repo_id,
            ownerId
          }).catch(err => console.error(`Recovery failed for coding session ${session.id}:`, err.message))
          trackJob(jobId, promise)
        }
      }
    } finally {
      await supabase.rpc('release_advisory_lock', { key: 'session_recovery' })
    }
  } catch (err) {
    console.error('Startup recovery failed:', err.message)
  }
}

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────
async function closeGracefully(signal) {
  console.log(`Received signal ${signal}, starting graceful shutdown...`)
  fastify.server.close()

  const jobs = Array.from(activeJobs.values())
  if (jobs.length > 0) {
    console.log(`Waiting for ${jobs.length} active jobs...`)
    await Promise.race([
      Promise.all(jobs),
      new Promise(resolve => setTimeout(resolve, 30000))
    ])
  }

  await supabase.removeAllChannels()
  process.exit(0)
}

process.on('SIGTERM', () => closeGracefully('SIGTERM'))
process.on('SIGINT', () => closeGracefully('SIGINT'))

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
