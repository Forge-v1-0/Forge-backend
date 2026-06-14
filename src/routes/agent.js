import { buildContext, getFileLanguage } from '../services/context.js'
import { loadMemory, writeMemory } from '../services/memory.js'
import { runPlanner, replanSubtask, generateExplanation } from '../services/planner.js'
import { runCoder } from '../services/coder.js'
import { createGithubClient } from '../services/github.js'
import pLimit from 'p-limit'

// ─── MODEL SANITIZER ─────────────────────────────────────────────
const DEAD_MODELS = {
  'anthropic/claude-3.5-sonnet': 'meta-llama/llama-4-maverick',
  'deepseek/deepseek-r1:free': 'meta-llama/llama-4-maverick',
  'poolside/laguna-m.1:free': 'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-maverick:free': 'meta-llama/llama-4-maverick'
}

function sanitizeModel(model) {
  if (!model) return 'meta-llama/llama-4-maverick'
  return DEAD_MODELS[model] || model
}

function normalizePath(p) {
  return (p || '').replace(/^\/+/, '')
}

// ─── ERROR HELPER ────────────────────────────────────────────────
function createError(message, code = 'INTERNAL_ERROR', statusCode = 500, details = null) {
  const err = { error: message, code }
  if (details) err.details = details
  return err
}

// ─── OWNERSHIP HELPERS ──────────────────────────────────────────
async function verifySessionOwnership(supabase, sessionId, userId) {
  const { data: session } = await supabase
    .from('sessions')
    .select('*, repos!inner(owner_id)')
    .eq('id', sessionId)
    .eq('repos.owner_id', userId)
    .single()
  return session
}

async function verifyDraftOwnership(supabase, draftId, userId) {
  const { data: draft } = await supabase
    .from('code_drafts')
    .select('*, tasks!inner(session_id, sessions!inner(repo_id, repos!inner(owner_id)))')
    .eq('id', draftId)
    .eq('tasks.sessions.repos.owner_id', userId)
    .single()
  return draft
}

async function verifyTaskOwnership(supabase, taskId, userId) {
  const { data: task } = await supabase
    .from('tasks')
    .select('*, sessions!inner(repo_id, repos!inner(owner_id))')
    .eq('id', taskId)
    .eq('sessions.repos.owner_id', userId)
    .single()
  return task
}

// ─── INPUT VALIDATION SCHEMAS ───────────────────────────────────
const schemas = {
  startSession: {
    body: {
      type: 'object',
      required: ['repo_id', 'task'],
      properties: {
        repo_id: { type: 'integer', minimum: 1 },
        task: { type: 'string', minLength: 1, maxLength: 5000 },
        plannerModel: { type: 'string', pattern: '^[a-z0-9-\/.:]+$', maxLength: 100 },
        coderModel: { type: 'string', pattern: '^[a-z0-9-\/.:]+$', maxLength: 100 }
      }
    }
  },
  approvePlan: {
    body: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'integer', minimum: 1 }
      }
    }
  },
  editPlan: {
    body: {
      type: 'object',
      required: ['session_id', 'subtasks'],
      properties: {
        session_id: { type: 'integer', minimum: 1 },
        subtasks: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            required: ['instruction', 'file_path'],
            properties: {
              instruction: { type: 'string', minLength: 1, maxLength: 5000 },
              file_path: { type: 'string', minLength: 1, maxLength: 500 },
              risk: { type: 'string', enum: ['low', 'medium', 'high'] },
              risk_reason: { type: 'string', maxLength: 500 }
            }
          }
        }
      }
    }
  },
  approveDraft: {
    body: {
      type: 'object',
      required: ['draft_id'],
      properties: {
        draft_id: { type: 'integer', minimum: 1 }
      }
    }
  },
  feedback: {
    body: {
      type: 'object',
      required: ['draft_id', 'feedback'],
      properties: {
        draft_id: { type: 'integer', minimum: 1 },
        feedback: { type: 'string', minLength: 1, maxLength: 2000 }
      }
    }
  }
}

export default async function agentRoutes(fastify) {
  const supabase = fastify.supabase
  // ─── LIST SESSIONS ───────────────────────────────────────────────
  fastify.get('/agent/sessions', async (req, reply) => {
    const owner_id = req.user.id
    const { repo_id, page = '1', limit = '20' } = req.query

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const offset = (pageNum - 1) * limitNum

    const { data: userRepos, error: repoError } = await supabase
      .from('repos')
      .select('id')
      .eq('owner_id', owner_id)
    if (repoError) return reply.status(500).send(createError(repoError.message, 'DB_ERROR'))

    const repoIds = userRepos?.map(r => r.id) || []
    if (repoIds.length === 0) {
      return reply.send({ sessions: [], pagination: { page: 1, limit: limitNum, total: 0, totalPages: 0 } })
    }

    let query = supabase
      .from('sessions')
      .select('*, repos(name, url)', { count: 'exact' })
      .in('repo_id', repoIds)
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (repo_id) query = query.eq('repo_id', parseInt(repo_id, 10))

    const { data, error, count } = await query
    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))

    return reply.send({
      sessions: data || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  })

  // ─── START SESSION ───────────────────────────────────────────────
  fastify.post('/agent/start', { schema: schemas.startSession }, async (req, reply) => {
    const { repo_id, task, plannerModel, coderModel } = req.body
    const owner_id = req.user.id

    const { data: repo } = await supabase
      .from('repos')
      .select('id')
      .eq('id', repo_id)
      .eq('owner_id', owner_id)
      .single()
    if (!repo) return reply.status(403).send(createError('Repo not found or unauthorized', 'FORBIDDEN', 403))

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({ repo_id, task, status: 'planning' })
      .select()
      .single()
    if (sessionError) return reply.status(500).send(createError(sessionError.message, 'DB_ERROR'))

    const jobId = `agent-${session.id}`
    const promise = runAgentLoop({ fastify, supabase, sessionId: session.id, repoId: repo_id, ownerId: owner_id, task, plannerModel, coderModel })
      .catch(async (err) => {
        console.error(`Agent loop failed for session ${session.id}:`, err)
        await supabase.from('sessions').update({ status: 'failed', error: err.message }).eq('id', session.id)
      })
    fastify.trackJob(jobId, promise)

    return reply.send({ ok: true, session_id: session.id })
  })

  // ─── APPROVE PLAN ────────────────────────────────────────────────
  fastify.post('/agent/approve-plan', { schema: schemas.approvePlan }, async (req, reply) => {
    const { session_id } = req.body
    const owner_id = req.user.id

    const { data: session } = await supabase.from('sessions')
      .update({ status: 'coding', approved_at: new Date().toISOString() })
      .eq('id', session_id)
      .eq('status', 'plan_review')
      .select('*, repos!inner(owner_id)')
      .eq('repos.owner_id', owner_id)
      .single()

    if (!session) {
      return reply.status(409).send(createError(
        'Session not in plan_review status or unauthorized',
        'CONFLICT',
        409
      ))
    }

    const planModels = session?.plan || {}
    const jobId = `coder-${session_id}`
    const promise = runCoderLoop({ fastify, supabase, sessionId: session_id, repoId: session.repo_id, ownerId: owner_id, plannerModel: planModels.plannerModel, coderModel: planModels.coderModel })
      .catch(async (err) => {
        console.error(`Coder loop failed:`, err)
        await supabase.from('sessions').update({ status: 'failed', error: err.message }).eq('id', session_id)
      })
    fastify.trackJob(jobId, promise)

    return reply.send({ ok: true, status: 'coding' })
  })

  // ─── EDIT PLAN ───────────────────────────────────────────────────
  fastify.post('/agent/edit-plan', { schema: schemas.editPlan }, async (req, reply) => {
    const { session_id, subtasks } = req.body
    const owner_id = req.user.id

    const session = await verifySessionOwnership(supabase, session_id, owner_id)
    if (!session || session.status !== 'plan_review') {
      return reply.status(409).send(createError('Session not in plan_review status or unauthorized', 'CONFLICT', 409))
    }

    await supabase.from('tasks').delete().eq('session_id', session_id).eq('status', 'pending')
    for (const subtask of subtasks) {
      await supabase.from('tasks').insert({
        session_id,
        type: 'WRITE',
        instruction: subtask.instruction,
        file_path: normalizePath(subtask.file_path),
        status: 'pending'
      })
    }
    if (session.plan) {
      session.plan.subtasks = subtasks
      await supabase.from('sessions').update({ plan: session.plan }).eq('id', session_id)
    }
    return reply.send({ ok: true })
  })

  // ─── GET SESSION STATUS ──────────────────────────────────────────
  fastify.get('/agent/session/:id', async (req, reply) => {
    const { id } = req.params
    const owner_id = req.user.id

    const session = await verifySessionOwnership(supabase, id, owner_id)
    if (!session) return reply.status(403).send(createError('Session not found or unauthorized', 'FORBIDDEN', 403))

    const { data, error } = await supabase
      .from('sessions')
      .select(`*, tasks (*), code_drafts (*)`)
      .eq('id', id)
      .single()

    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))
    return reply.send({ session: data })
  })

  // ─── STREAM PLAN (SSE) ─────────────────────────────────────────
  fastify.get('/agent/session/:id/stream-plan', async (req, reply) => {
    const { id } = req.params
    const owner_id = req.user.id

    const session = await verifySessionOwnership(supabase, id, owner_id)
    if (!session) return reply.status(403).send(createError('Session not found or unauthorized', 'FORBIDDEN', 403))

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    let aborted = false
    req.raw.on('close', () => { aborted = true })

    const heartbeat = setInterval(() => {
      if (aborted) return
      try {
        reply.raw.write(': heartbeat\n\n')
      } catch (e) {
        clearInterval(heartbeat)
        aborted = true
      }
    }, 30000)

    const maxDuration = setTimeout(() => {
      if (!aborted) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'TIMEOUT', message: 'Connection timeout' })}\n\n`)
        reply.raw.end()
        aborted = true
      }
    }, 300000)

    let attempts = 0
    const maxAttempts = 120
    while (attempts < maxAttempts && !aborted) {
      const { data: session } = await supabase.from('sessions').select('status, plan').eq('id', id).single()
      if (!session) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'NOT_FOUND', message: 'Session not found' })}\n\n`)
        reply.raw.end()
        clearInterval(heartbeat)
        clearTimeout(maxDuration)
        return reply
      }
      if (session.status === 'plan_review' && session.plan) {
        const subtasks = session.plan.subtasks || []
        const planText = `## Analysis\n${session.plan.analysis || ''}\n## Subtasks\n` +
          subtasks.map((s, i) => `${i + 1}. **${s.file_path}** (${s.risk || 'unknown'} risk)\n${s.instruction}${s.risk_reason ? '\n⚠️ ' + s.risk_reason : ''}`).join('\n')
        const chunks = planText.match(/.{1,20}/g) || []
        for (const chunk of chunks) {
          if (aborted) break
          reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`)
          await new Promise(r => setTimeout(r, 15))
        }
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        clearInterval(heartbeat)
        clearTimeout(maxDuration)
        return reply
      }
      if (session.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'PLAN_FAILED', message: 'Planning failed' })}\n\n`)
        reply.raw.end()
        clearInterval(heartbeat)
        clearTimeout(maxDuration)
        return reply
      }
      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }
    if (!aborted) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'TIMEOUT', message: 'Timeout waiting for plan' })}\n\n`)
    }
    reply.raw.end()
    clearInterval(heartbeat)
    clearTimeout(maxDuration)
    return reply
  })

  // ─── STREAM CODE (SSE) ─────────────────────────────────────────
  fastify.get('/agent/task/:id/stream-code', async (req, reply) => {
    const { id } = req.params
    const owner_id = req.user.id

    const task = await verifyTaskOwnership(supabase, id, owner_id)
    if (!task) return reply.status(403).send(createError('Task not found or unauthorized', 'FORBIDDEN', 403))

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    let aborted = false
    req.raw.on('close', () => { aborted = true })

    const heartbeat = setInterval(() => {
      if (aborted) return
      try {
        reply.raw.write(': heartbeat\n\n')
      } catch (e) {
        clearInterval(heartbeat)
        aborted = true
      }
    }, 30000)

    const maxDuration = setTimeout(() => {
      if (!aborted) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'TIMEOUT', message: 'Connection timeout' })}\n\n`)
        reply.raw.end()
        aborted = true
      }
    }, 300000)

    let attempts = 0
    const maxAttempts = 120
    while (attempts < maxAttempts && !aborted) {
      const { data: drafts } = await supabase.from('code_drafts')
        .select('new_content, explanation')
        .eq('task_id', id)
        .order('created_at', { ascending: false })
        .limit(1)

      if (drafts && drafts.length > 0 && drafts[0].new_content) {
        const draft = drafts[0]
        const content = draft.new_content
        const chunkSize = 30
        for (let i = 0; i < content.length; i += chunkSize) {
          if (aborted) break
          const chunk = content.slice(i, i + chunkSize)
          reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`)
          await new Promise(r => setTimeout(r, 10))
        }
        reply.raw.write(`data: ${JSON.stringify({ type: 'explanation', explanation: draft.explanation })}\n\n`)
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        clearInterval(heartbeat)
        clearTimeout(maxDuration)
        return reply
      }
      const { data: task } = await supabase.from('tasks').select('status').eq('id', id).single()
      if (task?.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'CODE_FAILED', message: 'Coding task failed' })}\n\n`)
        reply.raw.end()
        clearInterval(heartbeat)
        clearTimeout(maxDuration)
        return reply
      }
      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }
    if (!aborted) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', code: 'TIMEOUT', message: 'Timeout waiting for code draft' })}\n\n`)
    }
    reply.raw.end()
    clearInterval(heartbeat)
    clearTimeout(maxDuration)
    return reply
  })

  // ─── APPROVE DRAFT ─────────────────────────────────────────────
  fastify.post('/agent/approve', { schema: schemas.approveDraft }, async (req, reply) => {
    const { draft_id } = req.body
    const owner_id = req.user.id

    const draft = await verifyDraftOwnership(supabase, draft_id, owner_id)
    if (!draft) return reply.status(404).send(createError('Draft not found or unauthorized', 'NOT_FOUND', 404))

    const session = draft.tasks?.sessions
    const task = draft.tasks
    if (!session || !task) return reply.status(500).send(createError('Draft relations not loaded', 'RELATION_ERROR'))

    const repoId = session.repo_id
    const filePath = normalizePath(draft.file_path)
    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) return reply.status(500).send(createError('Missing PAT or repo identifier', 'CONFIG_ERROR'))

    const github = createGithubClient(pat, repo)
    const branchName = `agent/${session.id}`

    try {
      await github.createBranch(branchName)
    } catch (err) {
      const msg = err?.message || ''
      if (!msg.includes('already exists') && !msg.includes('Reference already exists')) throw err
    }

    await github.pushFile(filePath, draft.new_content, `agent: ${task?.instruction?.slice(0, 72) || 'update'}`, branchName)
    await supabase.from('code_drafts').update({ verdict: 'approved' }).eq('id', draft_id)
    await supabase.from('tasks').update({ status: 'done' }).eq('id', draft.task_id)

    await writeMemory(supabase, {
      repoId, sessionId: session.id, type: 'decision', filePath,
      summary: `Modified ${filePath}. Task: ${task?.instruction?.slice(0, 100) || 'update'}. Human approved.`,
      detail: { explanation: draft.explanation }
    })

    const { data: remainingTasks } = await supabase.from('tasks').select('id').eq('session_id', session.id).neq('status', 'done')
    if (!remainingTasks || remainingTasks.length === 0) {
      await supabase.from('sessions').update({ status: 'done' }).eq('id', session.id)
    }

    const githubUrl = `https://github.com/${repo}/blob/${branchName}/${filePath}`
    return reply.send({ ok: true, branch: branchName, github_url: githubUrl })
  })

  // ─── FEEDBACK / REVISION ─────────────────────────────────────────
  fastify.post('/agent/feedback', { schema: schemas.feedback }, async (req, reply) => {
    const { draft_id, feedback } = req.body
    const owner_id = req.user.id

    const draft = await verifyDraftOwnership(supabase, draft_id, owner_id)
    if (!draft) return reply.status(404).send(createError('Draft not found or unauthorized', 'NOT_FOUND', 404))

    const session = draft.tasks?.sessions
    const repoId = session.repo_id
    const planModels = session?.plan || {}

    await supabase.from('code_drafts').update({ verdict: 'revision_requested', feedback }).eq('id', draft_id)
    await writeMemory(supabase, {
      repoId, sessionId: session.id, type: 'rejection', filePath: normalizePath(draft.file_path),
      summary: `Draft rejected for ${draft.file_path}. Feedback: "${feedback}"`,
      detail: { feedback, failed_code: draft.new_content }
    })

    const jobId = `feedback-${draft_id}`
    const promise = runFeedbackLoop({ fastify, supabase, draft, feedback, repoId, sessionId: session.id, ownerId: owner_id, originalTask: session.task, plannerModel: planModels.plannerModel, coderModel: planModels.coderModel })
      .catch(async (err) => {
        console.error(`Feedback loop failed for draft ${draft_id}:`, err)
        await supabase.from('tasks').update({ status: 'failed', error: err.message }).eq('id', draft.task_id)
      })
    fastify.trackJob(jobId, promise)

    return reply.send({ ok: true })
  })
}

// ─── BACKGROUND: PLAN PHASE ─────────────────────────────────────────
export async function runAgentLoop({ fastify, supabase, sessionId, repoId, ownerId, task, plannerModel: passedPlannerModel, coderModel: passedCoderModel }) {
  const config = await fastify.getUserLLMConfig(ownerId)
  const plannerModel = sanitizeModel(passedPlannerModel || config.plannerModel)
  const coderModel = sanitizeModel(passedCoderModel || config.coderModel)

  const context = await buildContext(supabase, repoId)
  const memory = await loadMemory(supabase, repoId)
  const plan = await runPlanner({ task, context, memory, plannerModel, apiKey: config.apiKey })

  if (!plan?.subtasks || !Array.isArray(plan.subtasks)) throw new Error('Planner returned invalid subtasks')

  for (const subtask of plan.subtasks) {
    if (!subtask.file_path || !subtask.instruction) continue
    await supabase.from('tasks').insert({
      session_id: sessionId,
      type: 'WRITE',
      instruction: subtask.instruction,
      file_path: normalizePath(subtask.file_path),
      status: 'pending'
    })
  }

  await supabase.from('sessions').update({
    status: 'plan_review',
    plan: { analysis: plan.analysis, subtasks: plan.subtasks, plannerModel, coderModel }
  }).eq('id', sessionId)
}

// ─── BACKGROUND: CODER PHASE ────────────────────────────────────────
export async function runCoderLoop({ fastify, supabase, sessionId, repoId, ownerId, plannerModel: passedPlannerModel, coderModel: passedCoderModel }) {
  try {
    const { data: session } = await supabase.from('sessions').select('plan').eq('id', sessionId).single()
    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)
    if (!config || !config.apiKey) throw new Error(`Missing LLM config for owner ${ownerId}`)

    const plannerModel = sanitizeModel(passedPlannerModel || planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(passedCoderModel || planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    await supabase.from('tasks').update({ status: 'pending' }).eq('session_id', sessionId).eq('status', 'running')
    const { data: tasks } = await supabase.from('tasks')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (!tasks || tasks.length === 0) {
      await supabase.from('sessions').update({ status: 'done' }).eq('id', sessionId)
      return
    }

    await supabase.from('sessions').update({ status: 'coding' }).eq('id', sessionId)
    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) throw new Error(`Missing PAT or repo identifier for repoId ${repoId}`)

    const github = createGithubClient(pat, repo)
    const subtaskMap = {}
    for (const s of (session?.plan?.subtasks || [])) {
      if (s.file_path) subtaskMap[normalizePath(s.file_path)] = s
    }

    // Batch fetch all file languages upfront (N+1 fix)
    const filePaths = tasks.map(t => normalizePath(t.file_path))
    const { data: files } = await supabase
      .from('files')
      .select('path, language')
      .eq('repo_id', repoId)
      .in('path', filePaths)
    const langMap = new Map(files?.map(f => [f.path, f.language]) || [])

    // Check for existing drafts before processing (idempotency)
    const { data: existingDrafts } = await supabase
      .from('code_drafts')
      .select('task_id, verdict')
      .eq('verdict', 'awaiting_approval')
      .in('task_id', tasks.map(t => t.id))
    const draftTaskIds = new Set(existingDrafts?.map(d => d.task_id) || [])

    // ✅ FIX: Process up to 3 tasks concurrently instead of sequentially
    const limit = pLimit(3)

    const taskPromises = tasks.map(task => limit(async () => {
      try {
        if (!task.file_path) throw new Error(`Task ${task.id} is missing file_path`)
        const filePath = normalizePath(task.file_path)

        if (draftTaskIds.has(task.id)) {
          console.log(`Task ${task.id} already has draft awaiting approval, skipping`)
          return { taskId: task.id, status: 'skipped' }
        }

        // Atomic status update with check
        const { data: updatedTask } = await supabase.from('tasks')
          .update({ status: 'running', started_at: new Date().toISOString() })
          .eq('id', task.id)
          .eq('status', 'pending')
          .select()
          .single()

        if (!updatedTask) {
          console.log(`Task ${task.id} already being processed, skipping`)
          return { taskId: task.id, status: 'skipped' }
        }

        let language = langMap.get(filePath) || 'text'

        let currentContent
        try {
          currentContent = await github.getFileContent(filePath)
        } catch (fileErr) {
          const msg = fileErr?.message || String(fileErr)
          if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
            currentContent = null
          } else {
            throw fileErr
          }
        }
        const fileContent = currentContent == null ? '' : currentContent
        const subtaskMeta = subtaskMap[filePath] || {}

        const newContent = await runCoder({
          filePath, language, currentContent: fileContent,
          instruction: task.instruction,
          risk: subtaskMeta.risk, riskReason: subtaskMeta.risk_reason,
          coderModel, apiKey
        })
        const explanation = await generateExplanation({
          instruction: task.instruction, originalContent: fileContent,
          newContent, plannerModel, apiKey
        })

        await supabase.from('code_drafts').insert({
          session_id: sessionId, task_id: task.id, file_path: filePath,
          original_content: fileContent, new_content: newContent,
          explanation, verdict: 'awaiting_approval'
        })
        await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', task.id)
        return { taskId: task.id, status: 'success' }
      } catch (err) {
        console.error('DEBUG runCoderLoop task FAILED:', { id: task.id, file: task.file_path, error: err?.message || err })
        await supabase.from('tasks').update({ status: 'failed', error: err?.message || 'Unknown error' }).eq('id', task.id)
        return { taskId: task.id, status: 'failed', error: err?.message }
      }
    }))

    const results = await Promise.all(taskPromises)
    const successCount = results.filter(r => r.status === 'success').length
    const failCount = results.filter(r => r.status === 'failed').length
    const skippedCount = results.filter(r => r.status === 'skipped').length

    if (successCount > 0 && failCount > 0) {
      await supabase.from('sessions').update({
        status: 'partial_success',
        metadata: { failed_tasks: tasks.filter(t => t.status === 'failed').map(t => t.id) }
      }).eq('id', sessionId)
    } else if (successCount > 0 || skippedCount > 0) {
      await supabase.from('sessions').update({ status: 'awaiting_approval' }).eq('id', sessionId)
    } else {
      await supabase.from('sessions').update({ status: 'failed' }).eq('id', sessionId)
    }
  } catch (outerErr) {
    console.error('DEBUG runCoderLoop FATAL:', outerErr)
    await supabase.from('tasks').update({ status: 'failed', error: outerErr?.message || 'Loop-level failure' }).eq('session_id', sessionId).in('status', ['pending', 'running'])
    await supabase.from('sessions').update({ status: 'failed' }).eq('id', sessionId)
    throw outerErr
  }
}

// ─── BACKGROUND: FEEDBACK REPLAN LOOP ─────────────────────────────
async function runFeedbackLoop({ fastify, supabase, draft, feedback, repoId, sessionId, ownerId, originalTask, plannerModel: passedPlannerModel, coderModel: passedCoderModel }) {
  try {
    // Retry count stored on draft, not task
    const currentRetries = draft.retries || 0
    if (currentRetries >= 3) {
      throw new Error('Max feedback retries (3) reached. Manual intervention required.')
    }

    const { data: session } = await supabase.from('sessions').select('plan').eq('id', sessionId).single()
    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)
    if (!config || !config.apiKey) throw new Error(`Missing LLM config for owner ${ownerId}`)

    const plannerModel = sanitizeModel(passedPlannerModel || planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(passedCoderModel || planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    const context = await buildContext(supabase, repoId)
    const memory = await loadMemory(supabase, repoId, [normalizePath(draft.file_path)])
    const replan = await replanSubtask({
      originalTask, originalInstruction: draft.tasks?.instruction,
      failedCode: draft.new_content, feedback, context, memory,
      plannerModel, apiKey
    })

    // Update retries on draft, not task
    await supabase.from('code_drafts').update({ retries: currentRetries + 1 }).eq('id', draft.id)
    await supabase.from('tasks').update({
      instruction: replan.subtask.instruction,
      status: 'running'
    }).eq('id', draft.task_id)

    const filePath = normalizePath(draft.file_path)
    let language = await getFileLanguage(supabase, repoId, filePath)
    if (!language) language = 'text'

    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) throw new Error(`Missing PAT or repo identifier for repoId ${repoId}`)

    const github = createGithubClient(pat, repo)
    let currentContent
    try {
      currentContent = await github.getFileContent(filePath)
    } catch (fileErr) {
      const msg = fileErr?.message || String(fileErr)
      if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
        currentContent = null
      } else {
        throw fileErr
      }
    }
    const fileContent = currentContent == null ? '' : currentContent

    const newContent = await runCoder({
      filePath, language, currentContent: fileContent,
      instruction: replan.subtask.instruction,
      risk: replan.subtask.risk, riskReason: replan.subtask.risk_reason,
      feedback, coderModel, apiKey
    })
    const explanation = await generateExplanation({
      instruction: replan.subtask.instruction, originalContent: fileContent,
      newContent, plannerModel, apiKey
    })

    await supabase.from('code_drafts').insert({
      session_id: sessionId, task_id: draft.task_id, file_path: filePath,
      original_content: fileContent, new_content: newContent,
      explanation, verdict: 'awaiting_approval'
    })
    await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', draft.task_id)
  } catch (outerErr) {
    console.error('DEBUG runFeedbackLoop FATAL:', outerErr)
    await supabase.from('tasks').update({ status: 'failed', error: outerErr?.message || 'Feedback loop failure' }).eq('id', draft.task_id)
    throw outerErr
  }
}
