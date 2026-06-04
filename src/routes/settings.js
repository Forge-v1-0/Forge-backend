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
