import { buildContext } from '../services/context.js'
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

  // ─── START SESSION ───────────────────────────────────────────────
  fastify.post('/agent/start', async (req, reply) => {
    const { repo_id, task } = req.body
    const owner_id = req.user.id

    if (!repo_id || !task) {
      return reply.status(400).send({ error: 'Missing repo_id or task' })
    }

    // Create session immediately — return to frontend right away
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({ repo_id, task, status: 'planning' })
      .select()
      .single()

    if (sessionError) {
      return reply.status(500).send({ error: sessionError.message })
    }

    // Run agent loop in background — do not await
    runAgentLoop({
      fastify,
      supabase,
      sessionId: session.id,
      repoId: repo_id,
      ownerId: owner_id,
      task
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

    // Update status to coding
    await supabase.from('sessions').update({ status: 'coding' }).eq('id', session_id)

    const { data: repo } = await supabase
      .from('repos')
      .select('owner_id')
      .eq('id', session.repo_id)
      .single()

    if (!repo) return reply.status(404).send({ error: 'Repo not found' })

    // Run coder loop in background
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

    // Delete old pending tasks and replace with edited ones
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

    // Update the stored plan JSON as well
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
      .select(`
        *,
        tasks (*),
        code_drafts (*)
      `)
      .eq('id', id)
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ session: data })
  })

  // ─── APPROVE DRAFT ───────────────────────────────────────────────
  fastify.post('/agent/approve', async (req, reply) => {
    const { draft_id } = req.body
    if (!draft_id) {
      return reply.status(400).send({ error: 'Missing draft_id' })
    }

    // Load draft
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

    // Get repo PAT and details
    const { pat, repo } = await fastify.getRepoPat(repoId)
    const github = createGithubClient(pat, repo)

    // Create agent branch if it doesn't exist
    const branchName = `agent/${session.id}`
    await github.createBranch(branchName)

    // Push file to branch
    await github.pushFile(
      draft.file_path,
      draft.new_content,
      `agent: ${draft.tasks.instruction.slice(0, 72)}`,
      branchName
    )

    // Mark draft approved
    await supabase
      .from('code_drafts')
      .update({ verdict: 'approved' })
      .eq('id', draft_id)

    // Mark task done
    await supabase
      .from('tasks')
      .update({ status: 'done' })
      .eq('id', draft.task_id)

    // Write to memory
    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'decision',
      filePath: draft.file_path,
      summary: `Modified ${draft.file_path}. Task: ${draft.tasks.instruction.slice(0, 100)}. Human approved.`,
      detail: { explanation: draft.explanation }
    })

    // Check if all tasks in session are done
    const { data: remainingTasks } = await supabase
      .from('tasks')
      .select('id')
      .eq('session_id', session.id)
      .neq('status', 'done')

    if (!remainingTasks || remainingTasks.length === 0) {
      await supabase
        .from('sessions')
        .update({ status: 'done' })
        .eq('id', session.id)
    }

    return reply.send({ ok: true, branch: branchName })
  })

  // ─── FEEDBACK / REVISION ─────────────────────────────────────────
  fastify.post('/agent/feedback', async (req, reply) => {
    const { draft_id, feedback } = req.body
    const owner_id = req.user.id

    if (!draft_id || !feedback) {
      return reply.status(400).send({ error: 'Missing draft_id or feedback' })
    }

    // Load draft with full context
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

    // Mark draft as revision requested
    await supabase
      .from('code_drafts')
      .update({ verdict: 'revision_requested', feedback })
      .eq('id', draft_id)

    // Write rejection to memory
    await writeMemory(supabase, {
      repoId,
      sessionId: session.id,
      type: 'rejection',
      filePath: draft.file_path,
      summary: `Draft rejected for ${draft.file_path}. Feedback: "${feedback}"`,
      detail: { feedback, failed_code: draft.new_content }
    })

    // Run replan + recode in background
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
      await supabase
        .from('tasks')
        .update({ status: 'failed' })
        .eq('id', draft.task_id)
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
  task
}) {
  // Load user LLM config
  const { apiKey, plannerModel, coderModel } = await fastify.getUserLLMConfig(ownerId)

  // Load repo context and memory
  const context = await buildContext(supabase, repoId)
  const memory = await loadMemory(supabase, repoId)

  // Run planner
  const plan = await runPlanner({ task, context, memory, plannerModel, apiKey })

  // Store subtasks
  for (const subtask of plan.subtasks) {
    await supabase.from('tasks').insert({
      session_id: sessionId,
      type: 'WRITE',
      instruction: subtask.instruction,
      file_path: subtask.file_path,
      status: 'pending'
    })
  }

  // Save plan to session and pause for human review
  await supabase
    .from('sessions')
    .update({
      status: 'plan_review',
      plan: {
        analysis: plan.analysis,
        subtasks: plan.subtasks
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
  // Load user LLM config
  const { apiKey, plannerModel, coderModel } = await fastify.getUserLLMConfig(ownerId)

  // CRITICAL FOR RECOVERY: Reset any tasks stuck in 'running' due to a previous crash
  await supabase
    .from('tasks')
    .update({ status: 'pending' })
    .eq('session_id', sessionId)
    .eq('status', 'running')

  // Load tasks back in order
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

  // Update session to coding
  await supabase
    .from('sessions')
    .update({ status: 'coding' })
    .eq('id', sessionId)

  // Get repo details for GitHub
  const { pat, repo } = await fastify.getRepoPat(repoId)
  const github = createGithubClient(pat, repo)

  // Load plan for risk info
  const { data: session } = await supabase
    .from('sessions')
    .select('plan')
    .eq('id', sessionId)
    .single()

  // Get planner subtask details for risk info
  const subtaskMap = {}
  for (const s of (session?.plan?.subtasks || [])) {
    subtaskMap[s.file_path] = s
  }

  // Run coder for each subtask sequentially
  for (const task of tasks) {
    // Mark task as running
    await supabase
      .from('tasks')
      .update({ status: 'running' })
      .eq('id', task.id)

    // Get language from repo_index
    const { data: indexedFile } = await supabase
      .from('repo_index')
      .select('language')
      .eq('repo_id', repoId)
      .eq('path', task.file_path)
      .single()

    const language = indexedFile?.language || 'typescript'

    // Fetch current file from GitHub
    const currentContent = await github.getFileContent(task.file_path)

    // Get risk info from planner
    const subtaskMeta = subtaskMap[task.file_path] || {}

    // Run coder
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

    // Generate explanation via planner
    const explanation = await generateExplanation({
      instruction: task.instruction,
      originalContent: currentContent,
      newContent,
      plannerModel,
      apiKey
    })

    // Store draft
    await supabase.from('code_drafts').insert({
      session_id: sessionId,
      task_id: task.id,
      file_path: task.file_path,
      original_content: currentContent,
      new_content: newContent,
      explanation,
      verdict: 'awaiting_approval'
    })

    // Mark task as awaiting approval
    await supabase
      .from('tasks')
      .update({ status: 'awaiting_approval' })
      .eq('id', task.id)
  }

  // All subtasks done — session awaiting approval
  await supabase
    .from('sessions')
    .update({ status: 'awaiting_approval' })
    .eq('id', sessionId)
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
  const { apiKey, plannerModel, coderModel } = await fastify.getUserLLMConfig(ownerId)
  const context = await buildContext(supabase, repoId)
  
  // FILTERED MEMORY: Only load memory relevant to this specific file
  const memory = await loadMemory(supabase, repoId, [draft.file_path])

  // Planner rereplans the single failed subtask
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

  // Update the task with new instruction
  await supabase
    .from('tasks')
    .update({
      instruction: replan.subtask.instruction,
      status: 'running',
      retries: draft.tasks.retries + 1
    })
    .eq('id', draft.task_id)

  // Get language
  const { data: indexedFile } = await supabase
    .from('repo_index')
    .select('language')
    .eq('repo_id', repoId)
    .eq('path', draft.file_path)
    .single()

  const language = indexedFile?.language || 'typescript'

  // Get repo for GitHub access
  const { pat, repo } = await fastify.getRepoPat(repoId)
  const github = createGithubClient(pat, repo)
  const currentContent = await github.getFileContent(draft.file_path)

  // Coder reruns with feedback
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

  // Planner generates new explanation
  const explanation = await generateExplanation({
    instruction: replan.subtask.instruction,
    originalContent: currentContent,
    newContent,
    plannerModel,
    apiKey
  })

  // Store new draft
  await supabase.from('code_drafts').insert({
    session_id: sessionId,
    task_id: draft.task_id,
    file_path: draft.file_path,
    original_content: currentContent,
    new_content: newContent,
    explanation,
    verdict: 'awaiting_approval'
  })

  // Mark task awaiting approval again
  await supabase
    .from('tasks')
    .update({ status: 'awaiting_approval' })
    .eq('id', draft.task_id)
}
