// src/services/indexer.js
// SHA-based incremental re-indexing
// Polls all repos every 15 minutes and triggers re-index when the default branch SHA changes

import { createGithubClient } from './github.js'
import { decrypt } from './crypto.js'

const GITHUB_API = 'https://api.github.com'

/**
 * Check all repos for changes and trigger re-index if SHA changed
 * @param {object} supabase - Supabase client
 */
export async function checkAllReposForChanges(supabase) {
  const { data: repos, error } = await supabase
    .from('repos')
    .select('id, name, url, github_pat, default_branch, last_indexed_sha, index_status, source_root')
    .eq('index_status', 'indexed') // Only check repos that were successfully indexed

  if (error) {
    console.error('Failed to load repos for change detection:', error.message)
    return { checked: 0, updated: 0, errors: 1 }
  }

  if (!repos || repos.length === 0) {
    console.log('No indexed repos to check for changes')
    return { checked: 0, updated: 0, errors: 0 }
  }

  let updatedCount = 0
  let errorCount = 0

  for (const repo of repos) {
    try {
      const changed = await checkRepoForChanges(supabase, repo)
      if (changed) updatedCount++
    } catch (err) {
      console.error(`Change check failed for repo ${repo.id} (${repo.name}):`, err.message)
      errorCount++
    }
  }

  console.log(`🔍 Change detection complete: ${repos.length} checked, ${updatedCount} changed, ${errorCount} errors`)
  return { checked: repos.length, updated: updatedCount, errors: errorCount }
}

/**
 * Check a single repo for changes
 * @param {object} supabase - Supabase client
 * @param {object} repo - Repo record from DB
 * @returns {boolean} - true if re-index was triggered
 */
export async function checkRepoForChanges(supabase, repo) {
  if (!repo.github_pat) {
    console.warn(`Repo ${repo.id} has no PAT, skipping change check`)
    return false
  }

  // Decrypt PAT
  const pat = decrypt(repo.github_pat)

  // Derive owner/repo from URL
  let repoSlug = repo.name
  try {
    const url = new URL(repo.url)
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    if (path.includes('/')) repoSlug = path
  } catch {
    // Use raw name
  }

  const github = createGithubClient(pat, repoSlug)
  const branch = repo.default_branch || 'main'

  // Get latest commit SHA for default branch
  const latestSha = await getBranchSha(pat, repoSlug, branch)
  if (!latestSha) {
    console.warn(`Could not get SHA for ${repoSlug}/${branch}`)
    return false
  }

  // Compare with stored SHA
  if (latestSha === repo.last_indexed_sha) {
    // No changes
    return false
  }

  console.log(`📦 Repo ${repo.id} (${repoSlug}) changed: ${repo.last_indexed_sha?.slice(0, 7)} → ${latestSha.slice(0, 7)}`)

  // Trigger re-index
  await triggerReIndex(supabase, repo, pat, latestSha)
  return true
}

/**
 * Get the latest commit SHA for a branch via GitHub API
 */
async function getBranchSha(pat, repo, branch) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/git/ref/heads/${branch}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json'
    }
  })

  if (!res.ok) {
    if (res.status === 404) {
      console.warn(`Branch ${branch} not found in ${repo}`)
      return null
    }
    throw new Error(`GitHub ${res.status} getting branch SHA`)
  }

  const data = await res.json()
  return data.object?.sha || null
}

/**
 * Trigger re-indexing workflow and update stored SHA
 */
async function triggerReIndex(supabase, repo, pat, newSha) {
  // Update status to indicate re-indexing is in progress
  await supabase
    .from('repos')
    .update({
      index_status: 'indexing',
      last_indexed_sha: newSha // Update immediately to prevent duplicate triggers
    })
    .eq('id', repo.id)

  // Trigger the GitHub Actions workflow
  try {
    await triggerIndexWorkflow(repo, pat)
    console.log(`🚀 Re-index triggered for repo ${repo.id}`)
  } catch (err) {
    console.error(`Failed to trigger re-index for repo ${repo.id}:`, err.message)
    // Revert status so it will be checked again
    await supabase
      .from('repos')
      .update({ index_status: 'indexed' })
      .eq('id', repo.id)
    throw err
  }
}

/**
 * Trigger the GitHub Actions indexer workflow
 */
async function triggerIndexWorkflow(repo, userPat) {
  const indexerRepo = process.env.INDEXER_REPO
  const indexerPat = process.env.INDEXER_PAT
  if (!indexerRepo || !indexerPat) {
    throw new Error('INDEXER_REPO or INDEXER_PAT not set')
  }

  const targetRepo = repo.url.replace('https://github.com/', '').replace(/\/$/, '')

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
          repo_id: String(repo.id),
          pat_token: userPat,
          source_root: repo.source_root || ''
        }
      })
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Workflow dispatch failed: ${err}`)
  }
}

/**
 * Mark a repo as successfully indexed (called by indexer.js after completion)
 * @param {object} supabase - Supabase client
 * @param {number} repoId - Repo ID
 * @param {string} sha - The SHA that was indexed
 */
export async function markRepoIndexed(supabase, repoId, sha) {
  const { error } = await supabase
    .from('repos')
    .update({
      index_status: 'indexed',
      last_indexed_sha: sha,
      last_indexed_at: new Date().toISOString()
    })
    .eq('id', repoId)

  if (error) {
    console.error(`Failed to mark repo ${repoId} as indexed:`, error.message)
  } else {
    console.log(`✅ Repo ${repoId} marked as indexed at SHA ${sha.slice(0, 7)}`)
  }
}

/**
 * Manual re-index trigger for a specific repo
 * @param {object} supabase - Supabase client
 * @param {number} repoId - Repo ID
 * @param {string} userId - Owner ID (for verification)
 */
export async function manualReIndex(supabase, repoId, userId) {
  const { data: repo, error } = await supabase
    .from('repos')
    .select('id, name, url, github_pat, default_branch, source_root, owner_id')
    .eq('id', repoId)
    .eq('owner_id', userId)
    .single()

  if (error || !repo) {
    throw new Error('Repo not found or unauthorized')
  }

  const pat = decrypt(repo.github_pat)
  const branch = repo.default_branch || 'main'
  const latestSha = await getBranchSha(pat, repo.name, branch)

  if (!latestSha) {
    throw new Error('Could not get latest branch SHA')
  }

  await triggerReIndex(supabase, repo, pat, latestSha)
  return { ok: true, sha: latestSha }
}
