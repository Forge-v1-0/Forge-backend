export function createGithubClient(pat, repo) {
  if (!pat || !repo) throw new Error('createGithubClient: missing pat or repo')
  if (!repo.includes('/')) throw new Error(`createGithubClient: repo must be "owner/name", got "${repo}"`)

  const headers = {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  const base = `https://api.github.com/repos/${repo}`

  // Native fetch with AbortController timeout
  async function fetchGitHub(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...options, headers, signal: controller.signal })
      return res
    } finally {
      clearTimeout(id)
    }
  }

  async function getDefaultBranch() {
    const res = await fetchGitHub(base)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub getDefaultBranch ${res.status}: ${JSON.stringify(err)}`)
    }
    const data = await res.json()
    if (!data.default_branch) throw new Error('GitHub response missing default_branch')
    return data.default_branch
  }

  // Returns null ONLY for 404 (new file). Throws on 401/403/500 so the agent can see real errors.
  async function getFileContent(path) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    const res = await fetchGitHub(`${base}/contents/${cleanPath}`)

    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub getFileContent ${res.status} for ${cleanPath}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    if (Array.isArray(data)) throw new Error(`Path ${cleanPath} is a directory, not a file`)
    if (!data.content) throw new Error(`GitHub response for ${cleanPath} missing content field`)
    return Buffer.from(data.content, 'base64').toString('utf8')
  }

  async function getFileSha(path) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    const res = await fetchGitHub(`${base}/contents/${cleanPath}`)
    if (res.status === 404) return null
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub getFileSha ${res.status}: ${JSON.stringify(err)}`)
    }
    const data = await res.json()
    return data.sha || null
  }

  async function pushFile(path, content, message, branch) {
    const cleanPath = (path || '').replace(/^\/+/, '')
    const sha = await getFileSha(cleanPath)

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    }

    const res = await fetchGitHub(`${base}/contents/${cleanPath}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub pushFile ${res.status} for ${cleanPath}: ${JSON.stringify(err)}`)
    }
    return res.json()
  }

  async function createBranch(branchName) {
    const defaultBranch = await getDefaultBranch()
    const refRes = await fetchGitHub(`${base}/git/ref/heads/${defaultBranch}`)
    if (!refRes.ok) {
      const err = await refRes.json().catch(() => ({}))
      throw new Error(`GitHub getRef ${refRes.status}: ${JSON.stringify(err)}`)
    }
    const refData = await refRes.json()
    const sha = refData.object?.sha
    if (!sha) throw new Error('GitHub ref response missing SHA')

    const res = await fetchGitHub(`${base}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    })

    // 422 = already exists (safe to ignore)
    if (!res.ok && res.status !== 422) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub createBranch ${res.status}: ${JSON.stringify(err)}`)
    }
    return true
  }

  async function getRepoTree() {
    const branch = await getDefaultBranch()
    const res = await fetchGitHub(`${base}/git/trees/${branch}?recursive=1`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`GitHub getRepoTree ${res.status}: ${JSON.stringify(err)}`)
    }
    const data = await res.json()
    return (data.tree || []).filter(f => f.type === 'blob')
  }

  return {
    getDefaultBranch,
    getFileContent,
    getFileSha,
    pushFile,
    createBranch,
    getRepoTree
  }
}
