// ./src/plugins/llm-config.js
module.exports = async function (fastify, opts) {
  fastify.decorate('getUserLLMConfig', async (owner_id) => {
    // your existing logic from settings.js:112
    const { data, error } = await fastify.supabase
      .from('user_settings')
      .select('openrouter_api_key, planner_model, coder_model')
      .eq('owner_id', owner_id)
      .single();

    if (error) throw error;
    
    return {
      apiKey: data.openrouter_api_key,
      plannerModel: data.planner_model,
      coderModel: data.coder_model
    };
  });
};
