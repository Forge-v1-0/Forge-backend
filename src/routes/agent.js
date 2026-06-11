import { buildContext, getFileLanguage } from '../services/context.js'
import { loadMemory, writeMemory } from '../services/memory.js'
import { runPlanner, replanSubtask, generateExplanation } from '../services/planner.js'
import { runCoder } from '../services/coder.js'
import { createGithubClient } from '../services/github.js'

// ─── UTILS ───────────────────────────────────────────────────────
const DEAD_MODELS = {
  'anthropic/claude-3.5-sonnet': 'meta-llama/llama-4-maverick:free',
  'deepseek/deepseek-r1:free': 'meta-llama/llama-4-maverick:free',
  'poolside/laguna-m.1:free': 'meta-llama/llama-4-maverick:free'
}

function sanitizeModel(model) {
  if (!model) return 'meta-llama/llama-4-maverick:free'
  return DEAD_MODELS[model] || model
}

function normalizePath(p) {
  return (p || '').replace(/^\/+/, '')
}

export default async function agentRoutes(fastify) {
  const supabase = fastify.supabase

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString()
  }))

  // ─── LIST SESSIONS ───────────────────────────────────────────────
  fastify.get('/agent/sessions', async (req, reply) => {
    const owner_id = req.user.id
    const { repo_id } = req.query

    const { data: userRepos, error: repoError } = await supabase
      .from('repos')
      .select('id')
      .eq('owner_id', owner_id)

    if (repoError) {
      return reply.status(500).send({ error: repoError.message })
    }

    const repoIds = userRepos?.map(r => r.id) || []
    if (repoIds.length === 0) {
      return reply.send({ sessions: [] })
    }

    let query = supabase
      .from('sessions')
      .select('*, repos(name, url)')
      .in('repo_id', repoIds)
      .order('created_at', { ascending: false })

    if (repo_id) {
      query = query.eq('repo_id', repo_id)
    }

    const { data, error } = await query

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ sessions: data || [] })
  })

  // ─── START SESSION ───────────────────────────────────────────────
  fastify.post('/agent/start', async (req, reply) => {
    const { repo_id, task, plannerModel, coderModel } = req.body
    const owner_id = req.user.id

    console.log('DEBUG /agent/start body:', { repo_id, task, plannerModel, coderModel })

    if (!repo_id || !task) {
      return reply.status(400).send({ error: 'Missing repo_id or task' })
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({ repo_id, task, status: 'planning' })
      .select()
      .single()

    if (sessionError) {
      return reply.status(500).send({ error: sessionError.message })
    }

    runAgentLoop({
      fastify,
      supabase,
      sessionId: session.id,
      repoId: repo_id,
      ownerId: owner_id,
      task,
      plannerModel,
      coderModel
    }).catch(async (err) => {
      console.error(`Agent loop failed for session ${session.id}:`, err)
      await supabase
        .from('sessions')
        .update({ status: 'failed' })
        .eq('id', session.id)
    })

    return reply.send({ ok: true, session_id: session.id })
  })

  // ─── APPROVE PLAN ────────────────────────────────────────────────
  fastify.post('/agent/approve-plan', async (req, reply) => {
    const { session_id } = req.body
    if (!session_id) return reply.status(400).send({ error: 'Missing session_id' })

    const { data: session, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', session_id)
      .single()

    if (error || !session || session.status !== 'plan_review') {
      return reply.status(400).send({ error: 'Session not in plan_review status' })
    }

    await supabase.from('sessions').update({ status: 'coding' }).eq('id', session_id)

    const { data: repo } = await supabase
      .from('repos')
      .select('owner_id')
      .eq('id', session.repo_id)
      .single()

    if (!repo) return reply.status(404).send({ error: 'Repo not found' })

    runCoderLoop({
      fastify,
      supabase,
      sessionId: session_id,
      repoId: session.repo_id,
      ownerId: repo.owner_id
    }).catch(async (err) => {
      console.error(`Coder loop failed (handler catch):`, err)
      await supabase.from('sessions').update({ status: 'failed' }).eq('id', session_id)
    })

    return reply.send({ ok: true })
  })

  // ─── EDIT PLAN ───────────────────────────────────────────────────
  fastify.post('/agent/edit-plan', async (req, reply) => {
    const { session_id, subtasks } = req.body
    if (!session_id || !subtasks) {
      return reply.status(400).send({ error: 'Missing session_id or subtasks' })
    }

    const { data: session } = await supabase
      .from('sessions')
      .select('status, plan')
      .eq('id', session_id)
      .single()

    if (!session || session.status !== 'plan_review') {
      return reply.status(400).send({ error: 'Session not in plan_review status' })
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
    const { data, error } = await supabase
      .from('sessions')
      .select(`*, tasks (*), code_drafts (*)`)
      .eq('id', id)
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ session: data })
  })

  // ─── STREAM PLAN (SSE) ─────────────────────────────────────────
  fastify.get('/agent/session/:id/stream-plan', async (req, reply) => {
    const { id } = req.params

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    let attempts = 0
    const maxAttempts = 120

    while (attempts < maxAttempts) {
      const { data: session } = await supabase
        .from('sessions')
        .select('status, plan')
        .eq('id', id)
        .single()

      if (!session) {
        reply.raw.write(`data: ${JSON.stringify({ error: 'Session not found' })}\n\n`)
        reply.raw.end()
        return reply
      }

      if (session.status === 'plan_review' && session.plan) {
        const subtasks = session.plan.subtasks || []
        const planText = `## Analysis\n\n${session.plan.analysis || ''}\n\n## Subtasks\n\n` +
          subtasks.map((s, i) =>
            `${i + 1}. **${s.file_path}** (${s.risk || 'unknown'} risk)\n   ${s.instruction}${s.risk_reason ? '\n   ⚠️ ' + s.risk_reason : ''}`
          ).join('\n\n')

        const chunks = planText.match(/.{1,20}/g) || []
        for (const chunk of chunks) {
          reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`)
          await new Promise(r => setTimeout(r, 15))
        }
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        return reply
      }

      if (session.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ error: 'Planning failed' })}\n\n`)
        reply.raw.end()
        return reply
      }

      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }

    reply.raw.write(`data: ${JSON.stringify({ error: 'Timeout waiting for plan' })}\n\n`)
    reply.raw.end()
    return reply
  })

  // ─── STREAM CODE (SSE) ─────────────────────────────────────────
  fastify.get('/agent/task/:id/stream-code', async (req, reply) => {
    const { id } = req.params

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    let attempts = 0
    const maxAttempts = 120

    while (attempts < maxAttempts) {
      const { data: drafts } = await supabase
        .from('code_drafts')
        .select('new_content, explanation')
        .eq('task_id', id)
        .order('created_at', { ascending: false })
        .limit(1)

      if (drafts && drafts.length > 0 && drafts[0].new_content) {
        const draft = drafts[0]
        const content = draft.new_content
        const chunkSize = 30

        for (let i = 0; i < content.length; i += chunkSize) {
          const chunk = content.slice(i, i + chunkSize)
          reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`)
          await new Promise(r => setTimeout(r, 10))
        }

        reply.raw.write(`data: ${JSON.stringify({ explanation: draft.explanation })}\n\n`)
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        return reply
      }

      const { data: task } = await supabase
        .from('tasks')
        .select('status')
        .eq('id', id)
        .single()

      if (task?.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ error: 'Coding task failed' })}\n\n`)
        reply.raw.end()
        return reply
      }

      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }

    reply.raw.write(`data: ${JSON.stringify({ error: 'Timeout waiting for code draft' })}\n\n`)
    reply.raw.end()
    return reply
  })

  // ─── APPROVE DRAFT ─────────────────────────────────────────────
  fastify.post('/agent/approve', async (req, reply) => {
    const { draft_id } = req.body
    if (!draft_id) {
      return reply.status(400).send({ error: 'Missing draft_id' })
    }

    const { data: draft, error: draftError } = await supabase
      .from('code_drafts')
      .select('*, tasks(*), sessions(*)')
      .eq('id', draft_id)
      .single()

    if (draftError || !draft) {
      return reply.status(404).send({ error: 'Draft not found' })
    }

    const session = draft.sessions
    const task = draft.tasks
    if (!session || !task) {
      return reply.status(500).send({ error: 'Draft relations not loaded' })
    }

    const repoId = session.repo_id
    const filePath = normalizePath(draft.file_path)

    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) {
      return reply.status(500).send({ error: 'Missing PAT or repo identifier' })
    }
    const github = createGithubClient(pat, repo)

    const branchName = `agent/${session.id}`
    try {
      await github.createBranch(branchName)
    } catch (err) {
      const msg = err?.message || ''
      if (!msg.includes('already exists') && !msg.includes('Reference already exists')) {
        throw err
      }
    }

    await github.pushFile(
      filePath,
      draft.new_content,
      `agent: ${task?.instruction?.slice(0, 72) || 'update'}`,
      branchName
    )

    await supabase.from('code_drafts').update({ verdict: 'approved' }).eq('id', draft_id)
    await supabase.from('tasks').update({ status: 'done' }).eq('id', draft.task_id)

    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'decision',
      filePath,
      summary: `Modified ${filePath}. Task: ${task?.instruction?.slice(0, 100) || 'update'}. Human approved.`,
      detail: { explanation: draft.explanation }
    })

    const { data: remainingTasks } = await supabase
      .from('tasks')
      .select('id')
      .eq('session_id', session.id)
      .neq('status', 'done')

    if (!remainingTasks || remainingTasks.length === 0) {
      await supabase.from('sessions').update({ status: 'done' }).eq('id', session.id)
    }

    const githubUrl = `https://github.com/${repo}/blob/${branchName}/${filePath}`
    return reply.send({ ok: true, branch: branchName, github_url: githubUrl })
  })

  // ─── FEEDBACK / REVISION ─────────────────────────────────────────
  fastify.post('/agent/feedback', async (req, reply) => {
    const { draft_id, feedback } = req.body
    const owner_id = req.user.id

    if (!draft_id || !feedback) {
      return reply.status(400).send({ error: 'Missing draft_id or feedback' })
    }

    const { data: draft, error: draftError } = await supabase
      .from('code_drafts')
      .select('*, tasks(*), sessions(*)')
      .eq('id', draft_id)
      .single()

    if (draftError || !draft) {
      return reply.status(404).send({ error: 'Draft not found' })
    }

    const session = draft.sessions
    const repoId = session.repo_id

    await supabase.from('code_drafts').update({ verdict: 'revision_requested', feedback }).eq('id', draft_id)

    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'rejection',
      filePath: normalizePath(draft.file_path),
      summary: `Draft rejected for ${draft.file_path}. Feedback: "${feedback}"`,
      detail: { feedback, failed_code: draft.new_content }
    })

    runFeedbackLoop({
      fastify,
      supabase,
      draft,
      feedback,
      repoId,
      sessionId: session.id,
      ownerId: owner_id,
      originalTask: session.task
    }).catch(async (err) => {
      console.error(`Feedback loop failed for draft ${draft_id}:`, err)
      await supabase.from('tasks').update({ status: 'failed' }).eq('id', draft.task_id)
    })

    return reply.send({ ok: true })
  })
}

// ─── BACKGROUND: PLAN PHASE ─────────────────────────────────────────
export async function runAgentLoop({
  fastify,
  supabase,
  sessionId,
  repoId,
  ownerId,
  task,
  plannerModel: passedPlannerModel,
  coderModel: passedCoderModel
}) {
  const config = await fastify.getUserLLMConfig(ownerId)
  const plannerModel = sanitizeModel(passedPlannerModel || config.plannerModel)
  const coderModel = sanitizeModel(passedCoderModel || config.coderModel)

  console.log('DEBUG runAgentLoop models:', { plannerModel, coderModel })

  const context = await buildContext(supabase, repoId)
  const memory = await loadMemory(supabase, repoId)

  const plan = await runPlanner({ task, context, memory, plannerModel, apiKey: config.apiKey })

  if (!plan?.subtasks || !Array.isArray(plan.subtasks)) {
    throw new Error('Planner returned invalid subtasks')
  }

  for (const subtask of plan.subtasks) {
    if (!subtask.file_path || !subtask.instruction) {
      console.warn('DEBUG runAgentLoop skipping invalid subtask:', subtask)
      continue
    }
    await supabase.from('tasks').insert({
      session_id: sessionId,
      type: 'WRITE',
      instruction: subtask.instruction,
      file_path: normalizePath(subtask.file_path),
      status: 'pending'
    })
  }

  await supabase
    .from('sessions')
    .update({
      status: 'plan_review',
      plan: {
        analysis: plan.analysis,
        subtasks: plan.subtasks,
        plannerModel,
        coderModel
      }
    })
    .eq('id', sessionId)
}

// ─── BACKGROUND: CODER PHASE ────────────────────────────────────────
export async function runCoderLoop({
  fastify,
  supabase,
  sessionId,
  repoId,
  ownerId
}) {
  console.log('DEBUG runCoderLoop START:', { sessionId, repoId, ownerId })

  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('plan')
      .eq('id', sessionId)
      .single()

    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)

    if (!config || !config.apiKey) {
      throw new Error(`Missing LLM config for owner ${ownerId}`)
    }

    const plannerModel = sanitizeModel(planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    console.log('DEBUG runCoderLoop models:', { plannerModel, coderModel })

    // Recover any tasks that were left hanging in 'running' from a crashed previous loop
    await supabase
      .from('tasks')
      .update({ status: 'pending' })
      .eq('session_id', sessionId)
      .eq('status', 'running')

    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    console.log('DEBUG runCoderLoop tasks:', { count: tasks?.length || 0 })

    if (!tasks || tasks.length === 0) {
      console.log('DEBUG runCoderLoop: no pending tasks, marking done')
      await supabase.from('sessions').update({ status: 'done' }).eq('id', sessionId)
      return
    }

    await supabase.from('sessions').update({ status: 'coding' }).eq('id', sessionId)

    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) {
      throw new Error(`Missing PAT or repo identifier for repoId ${repoId}`)
    }
    const github = createGithubClient(pat, repo)

    // Map planner subtasks by file_path so the coder receives risk metadata
    const subtaskMap = {}
    for (const s of (session?.plan?.subtasks || [])) {
      if (s.file_path) subtaskMap[normalizePath(s.file_path)] = s
    }

    let successCount = 0
    let failCount = 0

    for (const task of tasks) {
      try {
        if (!task.file_path) {
          throw new Error(`Task ${task.id} is missing file_path`)
        }

        const filePath = normalizePath(task.file_path)
        console.log('DEBUG runCoderLoop processing task:', { id: task.id, file: filePath })

        await supabase.from('tasks').update({ status: 'running' }).eq('id', task.id)

        let language = await getFileLanguage(supabase, repoId, filePath)
        if (!language) language = 'text'

        let currentContent
        try {
          currentContent = await github.getFileContent(filePath)
        } catch (fileErr) {
          const msg = fileErr?.message || String(fileErr)
          if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
            console.log('DEBUG runCoderLoop file not found on GitHub, treating as new:', filePath)
            currentContent = null
          } else {
            throw fileErr
          }
        }

        const fileContent = currentContent == null ? '' : currentContent
        const subtaskMeta = subtaskMap[filePath] || {}

        const newContent = await runCoder({
          filePath,
          language,
          currentContent: fileContent,
          instruction: task.instruction,
          risk: subtaskMeta.risk,
          riskReason: subtaskMeta.risk_reason,
          coderModel,
          apiKey
        })

        const explanation = await generateExplanation({
          instruction: task.instruction,
          originalContent: fileContent,
          newContent,
          plannerModel,
          apiKey
        })

        await supabase.from('code_drafts').insert({
          session_id: sessionId,
          task_id: task.id,
          file_path: filePath,
          original_content: fileContent,
          new_content: newContent,
          explanation,
          verdict: 'awaiting_approval'
        })

        await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', task.id)
        successCount++
        console.log('DEBUG runCoderLoop task SUCCESS:', { id: task.id })
      } catch (err) {
        console.error('DEBUG runCoderLoop task FAILED:', { id: task.id, file: task.file_path, error: err?.message || err })
        await supabase.from('tasks').update({ status: 'failed', error: err?.message || 'Unknown error' }).eq('id', task.id)
        failCount++
      }
    }

    console.log('DEBUG runCoderLoop DONE:', { successCount, failCount })

    if (successCount > 0) {
      await supabase.from('sessions').update({ status: 'awaiting_approval' }).eq('id', sessionId)
    } else {
      await supabase.from('sessions').update({ status: 'failed' }).eq('id', sessionId)
    }
  } catch (outerErr) {
    console.error('DEBUG runCoderLoop FATAL:', outerErr)
    // Fail every task that is still pending or running so nothing is left dangling
    await supabase
      .from('tasks')
      .update({ status: 'failed', error: outerErr?.message || 'Loop-level failure' })
      .eq('session_id', sessionId)
      .in('status', ['pending', 'running'])

    await supabase.from('sessions').update({ status: 'failed' }).eq('id', sessionId)
    throw outerErr
  }
}

// ─── BACKGROUND: FEEDBACK REPLAN LOOP ─────────────────────────────
async function runFeedbackLoop({
  fastify,
  supabase,
  draft,
  feedback,
  repoId,
  sessionId,
  ownerId,
  originalTask
}) {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('plan')
      .eq('id', sessionId)
      .single()

    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)

    if (!config || !config.apiKey) {
      throw new Error(`Missing LLM config for owner ${ownerId}`)
    }

    const plannerModel = sanitizeModel(planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    console.log('DEBUG runFeedbackLoop models:', { plannerModel, coderModel })

    const context = await buildContext(supabase, repoId)
    const memory = await loadMemory(supabase, repoId, [normalizePath(draft.file_path)])

    const replan = await replanSubtask({
      originalTask,
      originalInstruction: draft.tasks?.instruction,
      failedCode: draft.new_content,
      feedback,
      context,
      memory,
      plannerModel,
      apiKey
    })

    await supabase
      .from('tasks')
      .update({
        instruction: replan.subtask.instruction,
        status: 'running',
        retries: (draft.tasks?.retries || 0) + 1
      })
      .eq('id', draft.task_id)

    const filePath = normalizePath(draft.file_path)
    let language = await getFileLanguage(supabase, repoId, filePath)
    if (!language) language = 'text'

    const { pat, repo } = await fastify.getRepoPat(repoId)
    if (!pat || !repo) {
      throw new Error(`Missing PAT or repo identifier for repoId ${repoId}`)
    }
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
      filePath,
      language,
      currentContent: fileContent,
      instruction: replan.subtask.instruction,
      risk: replan.subtask.risk,
      riskReason: replan.subtask.risk_reason,
      feedback,
      coderModel,
      apiKey
    })

    const explanation = await generateExplanation({
      instruction: replan.subtask.instruction,
      originalContent: fileContent,
      newContent,
      plannerModel,
      apiKey
    })

    await supabase.from('code_drafts').insert({
      session_id: sessionId,
      task_id: draft.task_id,
      file_path: filePath,
      original_content: fileContent,
      new_content: newContent,
      explanation,
      verdict: 'awaiting_approval'
    })

    await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', draft.task_id)
  } catch (outerErr) {
    console.error('DEBUG runFeedbackLoop FATAL:', outerErr)
    await supabase
      .from('tasks')
      .update({ status: 'failed', error: outerErr?.message || 'Feedback loop failure' })
      .eq('id', draft.task_id)
    throw outerErr
  }
}
