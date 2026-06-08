import { encrypt, decrypt } from '../services/crypto.js'

export default async function settingsRoutes(fastify) {
  const supabase = fastify.supabase

  fastify.post('/settings', async (req, reply) => {
    const { openrouter_api_key, planner_model, coder_model } = req.body
    const owner_id = req.user.id

    const encrypted_key = openrouter_api_key
      ? encrypt(openrouter_api_key)
      : null

    const { data, error } = await supabase
      .from('user_settings')
      .upsert({
        owner_id,
        ...(encrypted_key ? { openrouter_api_key: encrypted_key } : {}),
        planner_model: planner_model || 'anthropic/claude-3.5-sonnet',
        coder_model: coder_model || 'poolside/laguna-m.1:free',
        updated_at: new Date().toISOString()
      }, { onConflict: 'owner_id' })
      .select('id, owner_id, planner_model, coder_model, updated_at')
      .single()

    if (error) return reply.status(500).send({ error: error.message })

    return reply.send({ ok: true, settings: data })
  })

  fastify.get('/settings', async (req, reply) => {
    const owner_id = req.user.id

    const { data, error } = await supabase
      .from('user_settings')
      .select('id, owner_id, planner_model, coder_model, updated_at, openrouter_api_key')
      .eq('owner_id', owner_id)
      .single()

    if (error || !data) {
      return reply.send({
        settings: {
          planner_model: 'anthropic/claude-3.5-sonnet',
          coder_model: 'poolside/laguna-m.1:free',
          has_api_key: false
        }
      })
    }

    return reply.send({
      settings: {
        planner_model: data.planner_model,
        coder_model: data.coder_model,
        has_api_key: !!data.openrouter_api_key,
        updated_at: data.updated_at
      }
    })
  })

  fastify.delete('/settings/account', async (req, reply) => {
    const owner_id = req.user.id

    try {
      // Get all repos for this user
      const { data: repos } = await supabase
        .from('repos')
        .select('id')
        .eq('owner_id', owner_id)

      const repoIds = repos?.map(r => r.id) || []

      if (repoIds.length > 0) {
        // Get all sessions for these repos
        const { data: sessions } = await supabase
          .from('sessions')
          .select('id')
          .in('repo_id', repoIds)

        const sessionIds = sessions?.map(s => s.id) || []

        if (sessionIds.length > 0) {
          // Delete dependent records in correct order
          await supabase.from('agent_memory').delete().in('session_id', sessionIds)
          await supabase.from('code_drafts').delete().in('session_id', sessionIds)
          await supabase.from('tasks').delete().in('session_id', sessionIds)
          await supabase.from('sessions').delete().in('id', sessionIds)
        }

        // Delete repo-specific records
        await supabase.from('agent_memory').delete().in('repo_id', repoIds)
        await supabase.from('repo_index').delete().in('repo_id', repoIds)
        await supabase.from('repos').delete().in('id', repoIds)
      }

      // Delete user settings
      await supabase.from('user_settings').delete().eq('owner_id', owner_id)

      // Delete auth user (requires service role key)
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

  fastify.decorate('getUserLLMConfig', async (owner_id) => {
    const { data, error } = await supabase
      .from('user_settings')
      .select('openrouter_api_key, planner_model, coder_model')
      .eq('owner_id', owner_id)
      .single()

    if (error || !data) {
      throw new Error('No settings found. Please add your OpenRouter API key in settings.')
    }

    if (!data.openrouter_api_key) {
      throw new Error('OpenRouter API key not set. Please add it in settings.')
    }

    return {
      apiKey: decrypt(data.openrouter_api_key),
      plannerModel: data.planner_model,
      coderModel: data.coder_model
    }
  })
}
