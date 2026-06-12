import { encrypt, decrypt } from '../services/crypto.js'
import { createGithubClient } from '../services/github.js'

export default async function reposRoutes(fastify) {
  const supabase = fastify.supabase

  // ─── DETECT SOURCE ROOTS ─────────────────────────────────────────
  fastify.post('/repos/detect-roots', async (req, reply) => {
    const { url, github_pat } = req.body
    if (!url || !github_pat) {
      return reply.status(400).send({ error: 'Missing url or github_pat' })
    }

    const repo = url.replace('https://github.com/', '').replace(/\/$/, '')
    if (!repo.includes('/')) {
      return reply.status(400).send({ error: 'url must be a valid GitHub repository URL' })
    }

    try {
      const github = createGithubClient(github_pat, repo)
      const tree = await github.getRepoTree()
      const topDirs = tree
        .filter(f => f.type === 'tree' && !f.path.includes('/'))
        .map(f => f.path)

      const pkgPaths = tree
        .filter(f => f.path.endsWith('package.json'))
        .map(f => f.path.replace('/package.json', ''))
        .filter(p => p !== '')

      return reply.send({
        repo,
        top_level_directories: topDirs,
        detected_package_json_roots: pkgPaths.length ? pkgPaths : ['(root)']
      })
    } catch (err) {
      return reply.status(400).send({ error: err.message })
    }
  })

  // ─── CREATE REPO ─────────────────────────────────────────────────
  fastify.post('/repos', async (req, reply) => {
    const { name, url, github_pat, default_branch, source_root } = req.body
    const owner_id = req.user.id

    if (!name || !url || !github_pat) {
      return reply.status(400).send({ error: 'Missing required fields: name, url, github_pat' })
    }
    if (!url.startsWith('https://github.com/')) {
      return reply.status(400).send({ error: 'url must be a valid GitHub repository URL' })
    }

    const repoPath = url.replace('https://github.com/', '').replace(/\/$/, '')

    // ── Validate PAT + repo access before storing anything ──────
    try {
      const github = createGithubClient(github_pat, repoPath)
      await github.getDefaultBranch() // throws with human-readable message on auth failure
    } catch (err) {
      return reply.status(400).send({ error: `Cannot access repository: ${err.message}` })
    }

    const encrypted_pat = encrypt(github_pat)

    const { data, error } = await supabase
      .from('repos')
      .insert({
        name,
        url,
        github_pat: encrypted_pat,
        default_branch: default_branch || 'main',
        owner_id,
        index_status: 'pending',
        file_count: 0,
        source_root: source_root || null
      })
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    // ── Trigger index workflow ──────────────────────────────────
    // The plaintext PAT is passed here only as a workflow_dispatch input
    // (it travels over HTTPS to GitHub's API and is stored as a masked
    // ephemeral input, not in our DB or logs).
    try {
      await triggerIndexWorkflow(repoPath, data.id, github_pat, source_root)
      console.log(`Indexing triggered for ${repoPath} (root: ${source_root || 'repo root'})`)
    } catch (err) {
      console.error(`Failed to trigger indexing: ${err.message}`)
      return reply.status(500).send({
        error: 'Repo saved but indexing failed to start. You can retry indexing from the repo settings.',
        detail: err.message
      })
    }

    const { github_pat: _stripped, ...safeRepo } = data
    return reply.send({ ok: true, repo: safeRepo })
  })

  // ─── LIST REPOS ──────────────────────────────────────────────────
  fastify.get('/repos', async (req, reply) => {
    const owner_id = req.user.id

    const { data, error } = await supabase
      .from('repos')
      .select('id, name, url, default_branch, index_status, file_count, source_root, created_at')
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return reply.send({ repos: data })
  })

  // ─── DELETE REPO ─────────────────────────────────────────────────
  fastify.delete('/repos/:id', async (req, reply) => {
    const { id } = req.params
    const owner_id = req.user.id

    // Ownership check
    const { data: repo, error: repoErr } = await supabase
      .from('repos')
      .select('id')
      .eq('id', id)
      .eq('owner_id', owner_id)
      .maybeSingle()

    if (repoErr) return reply.status(500).send({ error: repoErr.message })
    if (!repo) return reply.status(404).send({ error: 'Repo not found or access denied' })

    const { data: sessions } = await supabase.from('sessions').select('id').eq('repo_id', id)
    const sessionIds = sessions?.map(s => s.id) || []

    if (sessionIds.length > 0) {
      await supabase.from('agent_memory').delete().in('session_id', sessionIds)
      await supabase.from('code_drafts').delete().in('session_id', sessionIds)
      await supabase.from('tasks').delete().in('session_id', sessionIds)
      await supabase.from('sessions').delete().in('id', sessionIds)
    }

    await supabase.from('agent_memory').delete().eq('repo_id', id)
    await supabase.from('repo_index').delete().eq('repo_id', id)
    await supabase.from('repos').delete().eq('id', id)

    return reply.send({ ok: true })
  })
}

// ─── WORKFLOW DISPATCH ────────────────────────────────────────────
async function triggerIndexWorkflow(targetRepo, repoId, userPat, sourceRoot) {
  const indexerRepo = process.env.INDEXER_REPO
  const indexerPat = process.env.INDEXER_PAT

  if (!indexerRepo || !indexerPat) {
    throw new Error('INDEXER_REPO or INDEXER_PAT env vars are not set')
  }

  const res = await fetch(
    `https://api.github.com/repos/${indexerRepo}/actions/workflows/on-demand-index.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${indexerPat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          target_repo: targetRepo,
          repo_id: String(repoId),
          pat_token: userPat,
          source_root: sourceRoot || ''
        }
      })
    }
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Workflow dispatch failed (${res.status}): ${body}`)
  }
}
