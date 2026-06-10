import { buildContext, getFileLanguage } from '../services/context.js'
import { loadMemory, writeMemory } from '../services/memory.js'
import { runPlanner, replanSubtask, generateExplanation } from '../services/planner.js'
import { runCoder } from '../services/coder.js'
import { createGithubClient } from '../services/github.js'

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
      console.error(`Agent loop failed for session ${session.id}:`, err.message)
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
      console.error(`Coder loop failed:`, err.message)
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
        file_path: subtask.file_path,
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
        const planText = `## Analysis\n\n${session.plan.analysis}\n\n## Subtasks\n\n` +
          session.plan.subtasks.map((s, i) =>
            `${i + 1}. **${s.file_path}** (${s.risk} risk)\n   ${s.instruction}${s.risk_reason ? '\n   ⚠️ ' + s.risk_reason : ''}`
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

  // ─── APPROVE DRAFT ───────────────────────────────────────────────
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
    const repoId = session.repo_id

    const { pat, repo } = await fastify.getRepoPat(repoId)
    const github = createGithubClient(pat, repo)

    const branchName = `agent/${session.id}`
    await github.createBranch(branchName)

    await github.pushFile(
      draft.file_path,
      draft.new_content,
      `agent: ${draft.tasks.instruction.slice(0, 72)}`,
      branchName
    )

    await supabase.from('code_drafts').update({ verdict: 'approved' }).eq('id', draft_id)
    await supabase.from('tasks').update({ status: 'done' }).eq('id', draft.task_id)

    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'decision',
      filePath: draft.file_path,
      summary: `Modified ${draft.file_path}. Task: ${draft.tasks.instruction.slice(0, 100)}. Human approved.`,
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

    const githubUrl = `https://github.com/${repo}/blob/${branchName}/${draft.file_path}`
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
      filePath: draft.file_path,
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
      console.error(`Feedback loop failed for draft ${draft_id}:`, err.message)
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
  const plannerModel = passedPlannerModel || config.plannerModel
  const coderModel = passedCoderModel || config.coderModel

  const context = await buildContext(supabase, repoId)
  const memory = await loadMemory(supabase, repoId)

  const plan = await runPlanner({ task, context, memory, plannerModel, apiKey: config.apiKey })

  for (const subtask of plan.subtasks) {
    await supabase.from('tasks').insert({
      session_id: sessionId,
      type: 'WRITE',
      instruction: subtask.instruction,
      file_path: subtask.file_path,
      status: 'pending'
    })
  }

  // Save models in plan so coder loop can use them later
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
  const { data: session } = await supabase
    .from('sessions')
    .select('plan')
    .eq('id', sessionId)
    .single()

  const planModels = session?.plan || {}
  const config = await fastify.getUserLLMConfig(ownerId)

  const plannerModel = planModels.plannerModel || config.plannerModel
  const coderModel = planModels.coderModel || config.coderModel
  const apiKey = config.apiKey

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

  if (!tasks || tasks.length === 0) {
    await supabase.from('sessions').update({ status: 'done' }).eq('id', sessionId)
    return
  }

  await supabase.from('sessions').update({ status: 'coding' }).eq('id', sessionId)

  const { pat, repo } = await fastify.getRepoPat(repoId)
  const github = createGithubClient(pat, repo)

  const subtaskMap = {}
  for (const s of (session?.plan?.subtasks || [])) {
    subtaskMap[s.file_path] = s
  }

  for (const task of tasks) {
    await supabase.from('tasks').update({ status: 'running' }).eq('id', task.id)

    const language = await getFileLanguage(supabase, repoId, task.file_path)
    const currentContent = await github.getFileContent(task.file_path)
    const subtaskMeta = subtaskMap[task.file_path] || {}

    const newContent = await runCoder({
      filePath: task.file_path,
      language,
      currentContent,
      instruction: task.instruction,
      risk: subtaskMeta.risk,
      riskReason: subtaskMeta.risk_reason,
      coderModel,
      apiKey
    })

    const explanation = await generateExplanation({
      instruction: task.instruction,
      originalContent: currentContent,
      newContent,
      plannerModel,
      apiKey
    })

    await supabase.from('code_drafts').insert({
      session_id: sessionId,
      task_id: task.id,
      file_path: task.file_path,
      original_content: currentContent,
      new_content: newContent,
      explanation,
      verdict: 'awaiting_approval'
    })

    await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', task.id)
  }

  await supabase.from('sessions').update({ status: 'awaiting_approval' }).eq('id', sessionId)
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
  const { data: session } = await supabase
    .from('sessions')
    .select('plan')
    .eq('id', sessionId)
    .single()

  const planModels = session?.plan || {}
  const config = await fastify.getUserLLMConfig(ownerId)

  const plannerModel = planModels.plannerModel || config.plannerModel
  const coderModel = planModels.coderModel || config.coderModel
  const apiKey = config.apiKey

  const context = await buildContext(supabase, repoId)
  const memory = await loadMemory(supabase, repoId, [draft.file_path])

  const replan = await replanSubtask({
    originalTask,
    originalInstruction: draft.tasks.instruction,
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
      retries: draft.tasks.retries + 1
    })
    .eq('id', draft.task_id)

  const language = await getFileLanguage(supabase, repoId, draft.file_path)

  const { pat, repo } = await fastify.getRepoPat(repoId)
  const github = createGithubClient(pat, repo)
  const currentContent = await github.getFileContent(draft.file_path)

  const newContent = await runCoder({
    filePath: draft.file_path,
    language,
    currentContent,
    instruction: replan.subtask.instruction,
    risk: replan.subtask.risk,
    riskReason: replan.subtask.risk_reason,
    feedback,
    coderModel,
    apiKey
  })

  const explanation = await generateExplanation({
    instruction: replan.subtask.instruction,
    originalContent: currentContent,
    newContent,
    plannerModel,
    apiKey
  })

  await supabase.from('code_drafts').insert({
    session_id: sessionId,
    task_id: draft.task_id,
    file_path: draft.file_path,
    original_content: currentContent,
    new_content: newContent,
    explanation,
    verdict: 'awaiting_approval'
  })

  await supabase.from('tasks').update({ status: 'awaiting_approval' }).eq('id', draft.task_id)
}
