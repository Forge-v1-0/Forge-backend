import { buildContext, getFileLanguage } from '../services/context.js'
import { loadMemory, writeMemory } from '../services/memory.js'
import { runPlanner, replanSubtask, generateExplanation } from '../services/planner.js'
import { runCoder } from '../services/coder.js'
import { createGithubClient } from '../services/github.js'
import { DEFAULT_MODELS } from '../services/llm.js'

// ─── MODEL SANITIZER ─────────────────────────────────────────────
// Dead models are remapped to the current default. This lives in one place only.
const DEAD_MODELS = {
  'anthropic/claude-3.5-sonnet': DEFAULT_MODELS.planner,
  'deepseek/deepseek-r1:free': DEFAULT_MODELS.planner,
  'poolside/laguna-m.1:free': DEFAULT_MODELS.planner,
  'meta-llama/llama-4-maverick:free': DEFAULT_MODELS.planner
}

function sanitizeModel(model) {
  if (!model || typeof model !== 'string') return DEFAULT_MODELS.planner
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

    if (repoError) return reply.status(500).send({ error: repoError.message })

    const repoIds = userRepos?.map(r => r.id) || []
    if (repoIds.length === 0) return reply.send({ sessions: [] })

    let query = supabase
      .from('sessions')
      .select('*, repos(name, url)')
      .in('repo_id', repoIds)
      .order('created_at', { ascending: false })

    if (repo_id) query = query.eq('repo_id', repo_id)

    const { data, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return reply.send({ sessions: data || [] })
  })

  // ─── START SESSION ───────────────────────────────────────────────
  fastify.post('/agent/start', async (req, reply) => {
    const { repo_id, task, plannerModel, coderModel } = req.body
    const owner_id = req.user.id

    if (!repo_id || !task) {
      return reply.status(400).send({ error: 'Missing repo_id or task' })
    }
    if (typeof task !== 'string' || task.trim().length < 5) {
      return reply.status(400).send({ error: 'task must be at least 5 characters' })
    }

    // Ownership check — prevent users from starting sessions on other users' repos
    const { data: repo } = await supabase
      .from('repos')
      .select('id, index_status')
      .eq('id', repo_id)
      .eq('owner_id', owner_id)
      .maybeSingle()

    if (!repo) return reply.status(404).send({ error: 'Repo not found or access denied' })

    if (repo.index_status !== 'indexed') {
      return reply.status(400).send({
        error: `Repo is not indexed yet (status: ${repo.index_status}). Wait for indexing to complete before starting a session.`
      })
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({ repo_id, task: task.trim(), status: 'planning', owner_id })
      .select()
      .single()

    if (sessionError) return reply.status(500).send({ error: sessionError.message })

    // Fire-and-forget. The loop uses a DB-level status check to prevent
    // double execution if startup recovery also picks this up.
    runAgentLoop({
      fastify,
      supabase,
      sessionId: session.id,
      repoId: repo_id,
      ownerId: owner_id,
      task: task.trim(),
      plannerModel,
      coderModel
    }).catch(async (err) => {
      console.error(`Agent loop failed for session ${session.id}:`, err.message)
      await supabase.from('sessions').update({ status: 'failed', error: err.message }).eq('id', session.id)
    })

    return reply.send({ ok: true, session_id: session.id })
  })

  // ─── APPROVE PLAN ────────────────────────────────────────────────
  fastify.post('/agent/approve-plan', async (req, reply) => {
    const { session_id } = req.body
    const owner_id = req.user.id

    if (!session_id) return reply.status(400).send({ error: 'Missing session_id' })

    const { data: session, error } = await supabase
      .from('sessions')
      .select('*, repos(owner_id)')
      .eq('id', session_id)
      .single()

    if (error || !session) return reply.status(404).send({ error: 'Session not found' })
    if (session.repos?.owner_id !== owner_id) return reply.status(403).send({ error: 'Access denied' })
    if (session.status !== 'plan_review') {
      return reply.status(400).send({ error: `Session is in '${session.status}' status, not 'plan_review'` })
    }

    // Atomic transition: only update if still in plan_review to prevent double-approval
    const { data: updated, error: updateErr } = await supabase
      .from('sessions')
      .update({ status: 'coding' })
      .eq('id', session_id)
      .eq('status', 'plan_review') // guard
      .select('id')
      .maybeSingle()

    if (updateErr) return reply.status(500).send({ error: updateErr.message })
    if (!updated) {
      return reply.status(409).send({ error: 'Session was already approved or modified by another request' })
    }

    const planModels = session?.plan || {}

    runCoderLoop({
      fastify,
      supabase,
      sessionId: session_id,
      repoId: session.repo_id,
      ownerId: owner_id,
      plannerModel: planModels.plannerModel,
      coderModel: planModels.coderModel
    }).catch(async (err) => {
      console.error(`Coder loop failed for session ${session_id}:`, err.message)
      await supabase.from('sessions').update({ status: 'failed', error: err.message }).eq('id', session_id)
    })

    return reply.send({ ok: true })
  })

  // ─── EDIT PLAN ───────────────────────────────────────────────────
  fastify.post('/agent/edit-plan', async (req, reply) => {
    const { session_id, subtasks } = req.body
    const owner_id = req.user.id

    if (!session_id || !Array.isArray(subtasks) || subtasks.length === 0) {
      return reply.status(400).send({ error: 'Missing session_id or subtasks array' })
    }

    const { data: session } = await supabase
      .from('sessions')
      .select('status, plan, repos(owner_id)')
      .eq('id', session_id)
      .single()

    if (!session) return reply.status(404).send({ error: 'Session not found' })
    if (session.repos?.owner_id !== owner_id) return reply.status(403).send({ error: 'Access denied' })
    if (session.status !== 'plan_review') {
      return reply.status(400).send({ error: `Session is in '${session.status}' status, not 'plan_review'` })
    }

    // Delete existing pending tasks and replace with the edited set
    await supabase.from('tasks').delete().eq('session_id', session_id).eq('status', 'pending')

    for (const subtask of subtasks) {
      if (!subtask.file_path || !subtask.instruction) continue
      await supabase.from('tasks').insert({
        session_id,
        type: 'WRITE',
        instruction: subtask.instruction,
        file_path: normalizePath(subtask.file_path),
        status: 'pending'
      })
    }

    if (session.plan) {
      await supabase
        .from('sessions')
        .update({ plan: { ...session.plan, subtasks } })
        .eq('id', session_id)
    }

    return reply.send({ ok: true })
  })

  // ─── GET SESSION STATUS ──────────────────────────────────────────
  fastify.get('/agent/session/:id', async (req, reply) => {
    const { id } = req.params
    const owner_id = req.user.id

    const { data, error } = await supabase
      .from('sessions')
      .select(`*, tasks (*), code_drafts (*), repos(owner_id)`)
      .eq('id', id)
      .single()

    if (error) return reply.status(500).send({ error: error.message })
    if (!data) return reply.status(404).send({ error: 'Session not found' })
    if (data.repos?.owner_id !== owner_id) return reply.status(403).send({ error: 'Access denied' })

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

    // Abort when the client disconnects to avoid orphaned DB polling loops
    let aborted = false
    req.raw.on('close', () => { aborted = true })

    let attempts = 0
    const maxAttempts = 90 // 90 × 2s = 3min max

    while (attempts < maxAttempts && !aborted) {
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
        const planText =
          `## Analysis\n\n${session.plan.analysis || ''}\n\n## Subtasks\n\n` +
          subtasks
            .map((s, i) =>
              `${i + 1}. **${s.file_path}** (${s.risk || 'unknown'} risk)\n   ${s.instruction}` +
              (s.risk_reason ? `\n   ⚠️ ${s.risk_reason}` : '')
            )
            .join('\n\n')

        const chunks = planText.match(/.{1,20}/g) || []
        for (const chunk of chunks) {
          if (aborted) break
          reply.raw.write(`data: ${JSON.stringify({ token: chunk })}\n\n`)
          await new Promise(r => setTimeout(r, 15))
        }
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        return reply
      }

      if (session.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ error: session.error || 'Planning failed' })}\n\n`)
        reply.raw.end()
        return reply
      }

      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }

    if (!aborted) {
      reply.raw.write(`data: ${JSON.stringify({ error: 'Timeout waiting for plan' })}\n\n`)
    }
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

    let aborted = false
    req.raw.on('close', () => { aborted = true })

    let attempts = 0
    const maxAttempts = 90

    while (attempts < maxAttempts && !aborted) {
      const { data: drafts } = await supabase
        .from('code_drafts')
        .select('new_content, explanation')
        .eq('task_id', id)
        .order('created_at', { ascending: false })
        .limit(1)

      if (drafts?.length > 0 && drafts[0].new_content) {
        const draft = drafts[0]
        const content = draft.new_content
        const chunkSize = 30

        for (let i = 0; i < content.length; i += chunkSize) {
          if (aborted) break
          reply.raw.write(`data: ${JSON.stringify({ token: content.slice(i, i + chunkSize) })}\n\n`)
          await new Promise(r => setTimeout(r, 10))
        }

        reply.raw.write(`data: ${JSON.stringify({ explanation: draft.explanation })}\n\n`)
        reply.raw.write(`data: [DONE]\n\n`)
        reply.raw.end()
        return reply
      }

      const { data: task } = await supabase
        .from('tasks')
        .select('status, error')
        .eq('id', id)
        .single()

      if (task?.status === 'failed') {
        reply.raw.write(`data: ${JSON.stringify({ error: task.error || 'Coding task failed' })}\n\n`)
        reply.raw.end()
        return reply
      }

      await new Promise(r => setTimeout(r, 2000))
      attempts++
    }

    if (!aborted) {
      reply.raw.write(`data: ${JSON.stringify({ error: 'Timeout waiting for code draft' })}\n\n`)
    }
    reply.raw.end()
    return reply
  })

  // ─── APPROVE DRAFT ─────────────────────────────────────────────
  fastify.post('/agent/approve', async (req, reply) => {
    const { draft_id } = req.body
    const owner_id = req.user.id

    if (!draft_id) return reply.status(400).send({ error: 'Missing draft_id' })

    const { data: draft, error: draftError } = await supabase
      .from('code_drafts')
      .select('*, tasks(*), sessions(*, repos(owner_id))')
      .eq('id', draft_id)
      .single()

    if (draftError || !draft) return reply.status(404).send({ error: 'Draft not found' })

    const session = draft.sessions
    const task = draft.tasks
    if (!session || !task) return reply.status(500).send({ error: 'Draft relations not loaded' })
    if (session.repos?.owner_id !== owner_id) return reply.status(403).send({ error: 'Access denied' })

    // Idempotency: if already approved, return success without re-pushing
    if (draft.verdict === 'approved') {
      return reply.send({ ok: true, already_approved: true })
    }

    const repoId = session.repo_id
    const filePath = normalizePath(draft.file_path)

    const { pat, repo } = await fastify.getRepoPat(repoId)
    const github = createGithubClient(pat, repo)

    const branchName = `agent/${session.id}`
    await github.createBranch(branchName) // idempotent — 422 is swallowed internally

    try {
      await github.pushFile(
        filePath,
        draft.new_content,
        `agent: ${task.instruction?.slice(0, 72) || 'update'}`,
        branchName
      )
    } catch (err) {
      // SHA conflict: surface actionable message, preserve the draft for retry
      if (err.message.includes('SHA conflict') || err.message.includes('409')) {
        return reply.status(409).send({
          error: 'SHA conflict: the file was modified on GitHub since this draft was generated. Re-approve to retry with the current SHA.',
          retry: true
        })
      }
      throw err
    }

    await supabase.from('code_drafts').update({ verdict: 'approved' }).eq('id', draft_id)
    await supabase.from('tasks').update({ status: 'done' }).eq('id', draft.task_id)

    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'decision',
      filePath,
      summary: `Modified ${filePath}. Task: ${task.instruction?.slice(0, 100) || 'update'}. Human approved.`,
      detail: { explanation: draft.explanation }
    })

    // Check if all tasks for this session are done
    const { data: remaining } = await supabase
      .from('tasks')
      .select('id, status')
      .eq('session_id', session.id)
      .neq('status', 'done')

    const nonFailedRemaining = (remaining || []).filter(t => t.status !== 'failed')
    if (nonFailedRemaining.length === 0) {
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
    if (typeof feedback !== 'string' || feedback.trim().length < 3) {
      return reply.status(400).send({ error: 'feedback must be at least 3 characters' })
    }

    const { data: draft, error: draftError } = await supabase
      .from('code_drafts')
      .select('*, tasks(*), sessions(*, repos(owner_id))')
      .eq('id', draft_id)
      .single()

    if (draftError || !draft) return reply.status(404).send({ error: 'Draft not found' })

    const session = draft.sessions
    if (!session) return reply.status(500).send({ error: 'Draft session relation not loaded' })
    if (session.repos?.owner_id !== owner_id) return reply.status(403).send({ error: 'Access denied' })

    const repoId = session.repo_id
    const planModels = session?.plan || {}

    await supabase
      .from('code_drafts')
      .update({ verdict: 'revision_requested', feedback: feedback.trim() })
      .eq('id', draft_id)

    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'rejection',
      filePath: normalizePath(draft.file_path),
      summary: `Draft rejected for ${draft.file_path}. Feedback: "${feedback.trim().slice(0, 200)}"`,
      detail: { feedback, failed_code: draft.new_content }
    })

    runFeedbackLoop({
      fastify,
      supabase,
      draft,
      feedback: feedback.trim(),
      repoId,
      sessionId: session.id,
      ownerId: owner_id,
      originalTask: session.task,
      plannerModel: planModels.plannerModel,
      coderModel: planModels.coderModel
    }).catch(async (err) => {
      console.error(`Feedback loop failed for draft ${draft_id}:`, err.message)
      await supabase
        .from('tasks')
        .update({ status: 'failed', error: err.message })
        .eq('id', draft.task_id)
    })

    return reply.send({ ok: true })
  })
}

// ─── BACKGROUND: PLAN PHASE ─────────────────────────────────────────
// Uses a DB-level CAS (compare-and-swap on status) to prevent double execution
// from concurrent startup recovery and the initial fire-and-forget.
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
  // CAS: only proceed if the session is still in 'planning'.
  // This prevents startup recovery from running a second loop when the
  // first is already in flight.
  const { data: claimed, error: claimErr } = await supabase
    .from('sessions')
    .update({ status: 'planning' }) // write same value to get row back only if it matches
    .eq('id', sessionId)
    .eq('status', 'planning')
    .select('id')
    .maybeSingle()

  if (claimErr) throw new Error(`runAgentLoop: failed to claim session: ${claimErr.message}`)
  if (!claimed) {
    console.log(`runAgentLoop: session ${sessionId} is no longer in 'planning' — skipping (already running or completed)`)
    return
  }

  try {
    const config = await fastify.getUserLLMConfig(ownerId)
    const plannerModel = sanitizeModel(passedPlannerModel || config.plannerModel)
    const coderModel = sanitizeModel(passedCoderModel || config.coderModel)

    const context = await buildContext(supabase, repoId)
    const memory = await loadMemory(supabase, repoId)

    const plan = await runPlanner({ task, context, memory, plannerModel, apiKey: config.apiKey })

    if (!plan?.subtasks || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
      throw new Error('Planner returned no valid subtasks')
    }

    for (const subtask of plan.subtasks) {
      if (!subtask.file_path || !subtask.instruction) {
        console.warn('runAgentLoop: skipping invalid subtask (missing file_path or instruction):', subtask)
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
        plan: { analysis: plan.analysis, subtasks: plan.subtasks, plannerModel, coderModel }
      })
      .eq('id', sessionId)
  } catch (err) {
    console.error(`runAgentLoop FATAL for session ${sessionId}:`, err.message)
    await supabase
      .from('sessions')
      .update({ status: 'failed', error: err.message })
      .eq('id', sessionId)
    throw err
  }
}

// ─── BACKGROUND: CODER PHASE ─────────────────────────────────────────
export async function runCoderLoop({
  fastify,
  supabase,
  sessionId,
  repoId,
  ownerId,
  plannerModel: passedPlannerModel,
  coderModel: passedCoderModel
}) {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('plan')
      .eq('id', sessionId)
      .single()

    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)

    if (!config?.apiKey) throw new Error(`Missing LLM config for owner ${ownerId}`)

    const plannerModel = sanitizeModel(passedPlannerModel || planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(passedCoderModel || planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    // Reset any tasks left in 'running' from a previously crashed loop.
    // This is only safe because we are now the single active loop — the
    // approve-plan route uses a CAS update to prevent double-execution.
    await supabase
      .from('tasks')
      .update({ status: 'pending' })
      .eq('session_id', sessionId)
      .eq('status', 'running')

    const { data: tasks, error: taskErr } = await supabase
      .from('tasks')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (taskErr) throw new Error(`Failed to fetch tasks: ${taskErr.message}`)

    if (!tasks || tasks.length === 0) {
      console.log(`runCoderLoop: no pending tasks for session ${sessionId}, marking done`)
      await supabase.from('sessions').update({ status: 'done' }).eq('id', sessionId)
      return
    }

    await supabase.from('sessions').update({ status: 'coding' }).eq('id', sessionId)

    const { pat, repo } = await fastify.getRepoPat(repoId)
    const github = createGithubClient(pat, repo)

    const subtaskMap = {}
    for (const s of (session?.plan?.subtasks || [])) {
      if (s.file_path) subtaskMap[normalizePath(s.file_path)] = s
    }

    let successCount = 0
    let failCount = 0

    for (const task of tasks) {
      try {
        if (!task.file_path) throw new Error(`Task ${task.id} is missing file_path`)

        const filePath = normalizePath(task.file_path)
        await supabase.from('tasks').update({ status: 'running' }).eq('id', task.id)

        const language = await getFileLanguage(supabase, repoId, filePath)
        const currentContent = await github.getFileContent(filePath) // null = new file
        const fileContent = currentContent ?? ''
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

        // newContent is already validated as non-truncated by llm.js (finish_reason check)

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
      } catch (err) {
        console.error(`runCoderLoop task FAILED [${task.id}] ${task.file_path}:`, err.message)
        await supabase
          .from('tasks')
          .update({ status: 'failed', error: err.message })
          .eq('id', task.id)
        failCount++
        // Continue to the next task — don't abort the whole session on one failure
      }
    }

    if (successCount > 0) {
      await supabase.from('sessions').update({ status: 'awaiting_approval' }).eq('id', sessionId)
    } else {
      await supabase
        .from('sessions')
        .update({ status: 'failed', error: `All ${failCount} task(s) failed` })
        .eq('id', sessionId)
    }
  } catch (outerErr) {
    console.error(`runCoderLoop FATAL for session ${sessionId}:`, outerErr.message)
    await supabase
      .from('tasks')
      .update({ status: 'failed', error: outerErr.message })
      .eq('session_id', sessionId)
      .in('status', ['pending', 'running'])

    await supabase
      .from('sessions')
      .update({ status: 'failed', error: outerErr.message })
      .eq('id', sessionId)
    throw outerErr
  }
}

// ─── BACKGROUND: FEEDBACK REPLAN LOOP ────────────────────────────
async function runFeedbackLoop({
  fastify,
  supabase,
  draft,
  feedback,
  repoId,
  sessionId,
  ownerId,
  originalTask,
  plannerModel: passedPlannerModel,
  coderModel: passedCoderModel
}) {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('plan')
      .eq('id', sessionId)
      .single()

    const planModels = session?.plan || {}
    const config = await fastify.getUserLLMConfig(ownerId)

    if (!config?.apiKey) throw new Error(`Missing LLM config for owner ${ownerId}`)

    const plannerModel = sanitizeModel(passedPlannerModel || planModels.plannerModel || config.plannerModel)
    const coderModel = sanitizeModel(passedCoderModel || planModels.coderModel || config.coderModel)
    const apiKey = config.apiKey

    const context = await buildContext(supabase, repoId)
    const filePath = normalizePath(draft.file_path)
    const memory = await loadMemory(supabase, repoId, [filePath])

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

    const language = await getFileLanguage(supabase, repoId, filePath)
    const { pat, repo } = await fastify.getRepoPat(repoId)
    const github = createGithubClient(pat, repo)

    const currentContent = await github.getFileContent(filePath)
    const fileContent = currentContent ?? ''

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
    console.error(`runFeedbackLoop FATAL for task ${draft.task_id}:`, outerErr.message)
    await supabase
      .from('tasks')
      .update({ status: 'failed', error: outerErr.message })
      .eq('id', draft.task_id)
    throw outerErr
  }
}
