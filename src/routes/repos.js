import { encrypt } from '../services/crypto.js'
import { createGithubClient } from '../services/github.js'

function createError(message, code = 'INTERNAL_ERROR', statusCode = 500, details = null) {
  const err = { error: message, code }
  if (details) err.details = details
  return err
}

export default async function reposRoutes(fastify) {
  const supabase = fastify.supabase

  // ─── DETECT SOURCE ROOTS ─────────────────────────────────────────
  fastify.post('/repos/detect-roots', async (req, reply) => {
    const { url, github_pat } = req.body
    if (!url || !github_pat) {
      return reply.status(400).send(createError('Missing url or github_pat', 'MISSING_FIELD', 400))
    }

    const repo = url.replace('https://github.com/', '').replace(/\/$/, '')
    const github = createGithubClient(github_pat, repo)
    try {
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
      return reply.status(500).send(createError(err.message, 'GITHUB_ERROR'))
    }
  })

  // ─── CREATE REPO ─────────────────────────────────────────────────
  fastify.post('/repos', async (req, reply) => {
    const { name, url, github_pat, default_branch, source_root } = req.body
    const owner_id = req.user.id

    if (!name || !url || !github_pat) {
      return reply.status(400).send(createError('Missing required fields', 'MISSING_FIELD', 400))
    }
    if (!url.startsWith('https://github.com/')) {
      return reply.status(400).send(createError('URL must be a valid GitHub repository URL', 'INVALID_URL', 400))
    }
    if (name.length > 100) {
      return reply.status(400).send(createError('Name must be 100 characters or less', 'VALIDATION_FAILED', 400))
    }

    const repoPath = url.replace('https://github.com/', '').replace(/\/$/, '')

    try {
      const validateRes = await fetch(`https://api.github.com/repos/${repoPath}`, {
        headers: {
          Authorization: `Bearer ${github_pat}`,
          Accept: 'application/vnd.github+json'
        }
      })
      if (!validateRes.ok) {
        return reply.status(400).send(createError('Cannot access repository. Check the URL and PAT permissions.', 'GITHUB_AUTH_ERROR', 400))
      }
    } catch (err) {
      return reply.status(400).send(createError('Failed to validate repository access', 'GITHUB_ERROR', 400))
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

    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))

    const targetRepo = url.replace('https://github.com/', '').replace(/\/$/, '')
    try {
      await triggerIndexWorkflow(targetRepo, data.id, github_pat, source_root)
      console.log(`Indexing triggered for ${targetRepo} (root: ${source_root || 'repo root'})`)
    } catch (err) {
      console.error(`Failed to trigger indexing: ${err.message}`)
      return reply.status(500).send({
        error: 'Repo saved, but indexing failed to start',
        code: 'WORKFLOW_FAILED',
        detail: err.message
      })
    }

    const { github_pat: _, ...safeRepo } = data
    return reply.send({ ok: true, repo: safeRepo })
  })

  // ─── LIST REPOS ──────────────────────────────────────────────────
  fastify.get('/repos', async (req, reply) => {
    const owner_id = req.user.id
    const { page = '1', limit = '20' } = req.query

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const offset = (pageNum - 1) * limitNum

    const { data, error, count } = await supabase
      .from('repos')
      .select('id, name, url, default_branch, index_status, file_count, source_root, created_at', { count: 'exact' })
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))
    return reply.send({
      repos: data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  })
}

async function triggerIndexWorkflow(targetRepo, repoId, userPat, sourceRoot) {
  const indexerRepo = process.env.INDEXER_REPO
  const indexerPat = process.env.INDEXER_PAT
  if (!indexerRepo || !indexerPat) {
    throw new Error('INDEXER_REPO or INDEXER_PAT not set')
  }
  const res = await fetch(
    `https://api.github.com/repos/${indexerRepo}/actions/workflows/on-demand-index.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${indexerPat}`,
        'Accept': 'application/vnd.github+json',
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
    const err = await res.text()
    throw new Error(`Workflow dispatch failed: ${err}`)
  }
}
