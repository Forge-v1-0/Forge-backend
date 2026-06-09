export function createGithubClient(pat, repo) {
  const headers = {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  }

  const base = `https://api.github.com/repos/${repo}`

  async function getDefaultBranch() {
    const res = await fetch(base, { headers })
    const data = await res.json()
    return data.default_branch
  }

  async function getFileContent(path) {
    const res = await fetch(`${base}/contents/${path}`, { headers })
    if (!res.ok) return null
    const data = await res.json()
    return Buffer.from(data.content, 'base64').toString('utf8')
  }
    if (!res.ok) return null
    return res.text()
  }

  async function getFileSha(path) {
    const res = await fetch(`${base}/contents/${path}`, { headers })
    if (!res.ok) return null
    const data = await res.json()
    return data.sha
  }

  async function pushFile(path, content, message, branch) {
    const sha = await getFileSha(path)

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    }

    const res = await fetch(`${base}/contents/${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(`GitHub push failed: ${JSON.stringify(err)}`)
    }

    return res.json()
  }

  async function createBranch(branchName) {
    const branch = await getDefaultBranch()

    // Get SHA of default branch tip
    const refRes = await fetch(
      `${base}/git/ref/heads/${branch}`,
      { headers }
    )
    const refData = await refRes.json()
    const sha = refData.object.sha

    const res = await fetch(`${base}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha
      })
    })

    // 422 means branch already exists — that's fine
    if (!res.ok && res.status !== 422) {
      const err = await res.json()
      throw new Error(`Branch creation failed: ${JSON.stringify(err)}`)
    }
  }

  async function getRepoTree() {
    const branch = await getDefaultBranch()
    const res = await fetch(
      `${base}/git/trees/${branch}?recursive=1`,
      { headers }
    )
    const data = await res.json()
    return data.tree.filter(f => f.type === 'blob')
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
