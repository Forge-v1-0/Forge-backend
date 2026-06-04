import { encrypt, decrypt } from '../services/crypto.js'

export default async function settingsRoutes(fastify) {
  const supabase = fastify.supabase

  // Save or update user settings
  fastify.post('/settings', async (req, reply) => {
    const { owner_id, openrouter_api_key, planner_model, coder_model } = req.body

    if (!owner_id) {
      return reply.status(400).send({ error: 'Missing owner_id' })
    }

    const encrypted_key = openrouter_api_key
      ? encrypt(openrouter_api_key)
      : null

    // Upsert — create if not exists, update if exists
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

  // Get settings — never expose the raw API key to frontend
  fastify.get('/settings/:owner_id', async (req, reply) => {
    const { owner_id } = req.params

    const { data, error } = await supabase
      .from('user_settings')
      .select('id, owner_id, planner_model, coder_model, updated_at, openrouter_api_key')
      .eq('owner_id', owner_id)
      .single()

    if (error || !data) {
      // Return defaults if no settings saved yet
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
        // Only tell frontend whether key exists, never send the actual key
        has_api_key: !!data.openrouter_api_key,
        updated_at: data.updated_at
      }
    })
  })

  // Internal helper used by agent logic — decrypts key for LLM calls
  fastify.decorate('getUserLLMConfig', async (owner_id) => {
    const { data, error } = await supabase
      .from('user_settings')
      .select('openrouter_api_key, planner_model, coder_model')
      .eq('owner_id', owner_id)
      .single()

    if (error || !data) {
      throw new Error('No settings found for user. Please add your OpenRouter API key in settings.')
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
