import { encrypt, decrypt } from '../services/crypto.js'
import { createGithubClient } from '../services/github.js'

export default async function reposRoutes(fastify) {
  const supabase = fastify.supabase

  // ─── DETECT SOURCE ROOTS ─────────────────────────────────────────
  fastify.post('/repos/detect-roots', async (req, reply) => {
  const { url, github_pat } = req.body // was req.query

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
      return reply.status(500).send({ error: err.message })
    }
  })

  // ─── CREATE REPO ─────────────────────────────────────────────────
  fastify.post('/repos', async (req, reply) => {
    const { name, url, github_pat, default_branch, source_root } = req.body
    const owner_id = req.user.id

    if (!name || !url || !github_pat) {
      return reply.status(400).send({ error: 'Missing required fields' })
    }

    const encrypted_pat = encrypt(github_pat)

    const { data, error } = await supabase
      .from('repos')
      .insert({
        name,
        url,
        github_pat: encrypted_pat,
        default_branch: default_branch || 'main',
        source_root: source_root || null,
        owner_id
      })
      .select()
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    const targetRepo = url.replace('https://github.com/', '').replace(/\/$/, '')

    try {
      await triggerIndexWorkflow(targetRepo, data.id, github_pat, source_root)
      console.log(`Indexing triggered for ${targetRepo} (root: ${source_root || 'repo root'})`)
    } catch (err) {
      console.error(`Failed to trigger indexing: ${err.message}`)
    }

    const { github_pat: _, ...safeRepo } = data
    return reply.send({ ok: true, repo: safeRepo })
  })

  // ─── LIST REPOS ──────────────────────────────────────────────────
  fastify.get('/repos', async (req, reply) => {
    const owner_id = req.user.id

    const { data, error } = await supabase
      .from('repos')
      .select('id, name, url, default_branch, source_root, created_at')
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ repos: data })
  })

  // ─── DECORATOR: getRepoPat ───────────────────────────────────────
  fastify.decorate('getRepoPat', async (repoId) => {
    const { data, error } = await supabase
      .from('repos')
      .select('github_pat, url, source_root')
      .eq('id', repoId)
      .single()

    if (error || !data) throw new Error('Repo not found')

    return {
      pat: decrypt(data.github_pat),
      url: data.url,
      repo: data.url.replace('https://github.com/', '').replace(/\/$/, ''),
      sourceRoot: data.source_root
    }
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
          repo_id: repoId,
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
