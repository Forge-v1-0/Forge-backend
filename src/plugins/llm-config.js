import { decrypt } from '../services/crypto.js'

export default async function llmConfigPlugin(fastify, opts) {
  fastify.decorate('getUserLLMConfig', async (owner_id) => {
    const { data, error } = await fastify.supabase
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
