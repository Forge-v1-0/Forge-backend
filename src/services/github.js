// github.js
// All GitHub API interactions go through this module.
// Throws Error with human-readable messages on every non-OK status.

const GITHUB_API = 'https://api.github.com'

export function createGithubClient(pat, repo) {
  if (!pat || typeof pat !== 'string') throw new Error('createGithubClient: pat is required')
  if (!repo || !repo.includes('/')) {
    throw new Error(`createGithubClient: repo must be "owner/name", got "${repo}"`)
  }

  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  const base = `${GITHUB_API}/repos/${repo}`

  // ─── INTERNAL FETCH WITH RATE LIMIT TRACKING ─────────────────
  async function ghFetch(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } })

    const remaining = res.headers.get('X-RateLimit-Remaining')
    const resetAt = res.headers.get('X-RateLimit-Reset')
    if (remaining && parseInt(remaining) < 10) {
      console.warn(`GitHub rate limit low: ${remaining} remaining, resets at ${new Date(resetAt * 1000).toISOString()}`)
    }

    return res
  }

  function handleStatus(res, context) {
    if (res.status === 401) throw new Error(`GitHub 401 on ${context}: PAT is invalid or expired. Re-save your GitHub token in settings.`)
    if (res.status === 403) throw new Error(`GitHub 403 on ${context}: PAT lacks the required scope. Ensure it has 'repo' (or 'contents:write') access.`)
    if (res.status === 404) throw new Error(`GitHub 404 on ${context}: resource not found. Check the repository URL and PAT access.`)
    if (res.status === 422) throw new Error(`GitHub 422 on ${context}: validation failed (branch may already exist or SHA conflict).`)
    if (res.status === 409) throw new Error(`GitHub 409 on ${context}: SHA conflict — the file was modified remotely between fetch and push. Please retry.`)
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${context}`)
  }

  // ─── DEFAULT BRANCH (cached per client instance) ───────────────
  let _defaultBranch = null
  async function getDefaultBranch() {
    if (_defaultBranch) return _defaultBranch
    const res = await ghFetch(base)
    handleStatus(res, 'getDefaultBranch')
    const data = await res.json()
    _defaultBranch = data.default_branch
    if (!_defaultBranch) throw new Error('GitHub repo response missing default_branch field')
    return _defaultBranch
  }

  // ─── REPO FILE TREE ────────────────────────────────────────────
  async function getRepoTree() {
    const branch = await getDefaultBranch()
    const res = await ghFetch(`${base}/git/trees/${branch}?recursive=1`)
    handleStatus(res, 'getRepoTree')
    const data = await res.json()
    if (data.truncated) {
      throw new Error(
        'GitHub tree response was truncated (repo has > 100,000 entries). ' +
        'Set SOURCE_ROOT to a subdirectory to reduce scope, or split the repo.'
      )
    }
    return (data.tree || []).filter(f => f.type === 'blob')
  }

  // ─── FILE CONTENT ──────────────────────────────────────────────
  async function getFileContent(path, branchName = null) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    let url = `${base}/contents/${cleanPath}`
    if (branchName) url += `?ref=${branchName}`
    const res = await ghFetch(url)
    if (res.status === 404) return null
    handleStatus(res, `getFileContent(${cleanPath})`)
    const data = await res.json()
    if (Array.isArray(data)) throw new Error(`Path ${cleanPath} is a directory, not a file`)
    if (!data.content) throw new Error(`GitHub response for ${cleanPath} missing content field`)
    return Buffer.from(data.content, 'base64').toString('utf8')
  }

  // ─── FILE SHA ──────────────────────────────────────────────────
  async function getFileSha(path, branchName = null) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    let url = `${base}/contents/${cleanPath}`
    if (branchName) url += `?ref=${branchName}`
    const res = await ghFetch(url)
    if (res.status === 404) return null
    handleStatus(res, `getFileSha(${cleanPath})`)
    const data = await res.json()
    return data.sha || null
  }

  // ─── PUSH FILE ─────────────────────────────────────────────────
  async function pushFile(path, content, message, branch) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    const sha = await getFileSha(cleanPath, branch)

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    }

    const res = await ghFetch(`${base}/contents/${cleanPath}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    })

    if (res.status === 409) {
      throw new Error(
        `SHA conflict pushing ${cleanPath}: the file was modified remotely between fetch and push. ` +
        'The draft is preserved. Please re-approve to retry with the current SHA.'
      )
    }
    handleStatus(res, `pushFile(${cleanPath})`)
    return res.json()
  }

  // ─── CREATE BRANCH ─────────────────────────────────────────────
  async function createBranch(branchName) {
    const defaultBranch = await getDefaultBranch()
    const refRes = await ghFetch(`${base}/git/ref/heads/${defaultBranch}`)
    handleStatus(refRes, `getRef(${defaultBranch})`)
    const refData = await refRes.json()
    const sha = refData.object?.sha
    if (!sha) throw new Error('GitHub ref response missing SHA')

    const res = await ghFetch(`${base}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    })

    if (res.status === 422) return true // Branch already exists — idempotent
    handleStatus(res, `createBranch(${branchName})`)
    return true
  }

  // ─── ENSURE BRANCH AND PUSH (atomic helper) ──────────────────
  async function ensureBranchAndPush(branchName, filePath, content, message) {
    try {
      await createBranch(branchName)
    } catch (err) {
      if (!err.message.includes('already exists')) throw err
    }

    let sha = null
    try {
      sha = await getFileSha(filePath, branchName)
    } catch (e) {
      // File doesn't exist on branch
    }

    return pushFile(filePath, content, message, branchName)
  }

  return {
    getDefaultBranch,
    getRepoTree,
    getFileContent,
    getFileSha,
    pushFile,
    createBranch,
    ensureBranchAndPush
  }
}
