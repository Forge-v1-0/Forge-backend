import { encrypt, decrypt } from '../services/crypto.js'

const DEFAULT_PLANNER = 'meta-llama/llama-4-maverick:free'
const DEFAULT_CODER = 'meta-llama/llama-4-maverick:free'

// Minimal sanity-check for OpenRouter key format before storing
function isValidOpenRouterKey(key) {
  return typeof key === 'string' && key.startsWith('sk-or-') && key.length > 20
}

export default async function settingsRoutes(fastify) {
  const supabase = fastify.supabase

  // ─── SAVE SETTINGS ─────────────────────────────────────────────
  fastify.post('/settings', async (req, reply) => {
    const { openrouter_api_key, planner_model, coder_model } = req.body
    const owner_id = req.user.id

    // Validate key format when provided
    if (openrouter_api_key !== undefined && openrouter_api_key !== null && openrouter_api_key !== '') {
      if (!isValidOpenRouterKey(openrouter_api_key)) {
        return reply.status(400).send({
          error: 'Invalid OpenRouter API key format. Keys must start with "sk-or-".'
        })
      }
    }

    const finalPlanner = planner_model ?? DEFAULT_PLANNER
    const finalCoder = coder_model ?? DEFAULT_CODER

    // Only include encrypted key in the upsert payload when explicitly provided.
    // Omitting it prevents accidentally overwriting an existing key with null
    // when the user saves only model preferences.
    const upsertPayload = {
      owner_id,
      planner_model: finalPlanner,
      coder_model: finalCoder,
      updated_at: new Date().toISOString()
    }

    if (openrouter_api_key) {
      upsertPayload.openrouter_api_key = encrypt(openrouter_api_key)
    }

    const { data, error } = await supabase
      .from('user_settings')
      .upsert(upsertPayload, { onConflict: 'owner_id' })
      .select('id, owner_id, planner_model, coder_model, updated_at')
      .single()

    if (error) {
      console.error('settings save error:', error)
      return reply.status(500).send({ error: error.message })
    }

    return reply.send({ ok: true, settings: data })
  })

  // ─── GET SETTINGS ──────────────────────────────────────────────
  fastify.get('/settings', async (req, reply) => {
    const owner_id = req.user.id

    const { data, error } = await supabase
      .from('user_settings')
      .select('id, owner_id, planner_model, coder_model, updated_at, openrouter_api_key')
      .eq('owner_id', owner_id)
      .maybeSingle()

    if (error) {
      console.error('settings GET error:', error)
      return reply.status(500).send({ error: error.message })
    }

    if (!data) {
      return reply.send({
        settings: {
          planner_model: DEFAULT_PLANNER,
          coder_model: DEFAULT_CODER,
          has_api_key: false
        }
      })
    }

    return reply.send({
      settings: {
        planner_model: data.planner_model || DEFAULT_PLANNER,
        coder_model: data.coder_model || DEFAULT_CODER,
        has_api_key: !!data.openrouter_api_key,
        updated_at: data.updated_at
      }
    })
  })

  // ─── DELETE ACCOUNT ────────────────────────────────────────────
  fastify.delete('/settings/account', async (req, reply) => {
    const owner_id = req.user.id

    try {
      const { data: repos } = await supabase.from('repos').select('id').eq('owner_id', owner_id)
      const repoIds = repos?.map(r => r.id) || []

      if (repoIds.length > 0) {
        const { data: sessions } = await supabase.from('sessions').select('id').in('repo_id', repoIds)
        const sessionIds = sessions?.map(s => s.id) || []

        if (sessionIds.length > 0) {
          await supabase.from('agent_memory').delete().in('session_id', sessionIds)
          await supabase.from('code_drafts').delete().in('session_id', sessionIds)
          await supabase.from('tasks').delete().in('session_id', sessionIds)
          await supabase.from('sessions').delete().in('id', sessionIds)
        }

        await supabase.from('agent_memory').delete().in('repo_id', repoIds)
        await supabase.from('repo_index').delete().in('repo_id', repoIds)
        await supabase.from('repos').delete().in('id', repoIds)
      }

      await supabase.from('user_settings').delete().eq('owner_id', owner_id)

      const { error: authError } = await supabase.auth.admin.deleteUser(owner_id)
      if (authError) {
        console.error('Failed to delete auth user:', authError.message)
        return reply.status(500).send({ error: 'Failed to delete auth user' })
      }

      return reply.send({ ok: true })
    } catch (err) {
      console.error('Account deletion failed:', err.message)
      return reply.status(500).send({ error: err.message })
    }
  })
}
