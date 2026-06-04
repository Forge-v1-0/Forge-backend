export const DEFAULT_MODELS = {
  planner: 'anthropic/claude-3.5-sonnet',
  coder: 'poolside/laguna-m.1:free'
}

export async function callLLM(messages, model, apiKey) {
  if (!apiKey) {
    throw new Error('No OpenRouter API key provided')
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/vitoraos/coder-agent',
      'X-Title': 'coder-agent'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0.2,
      messages
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenRouter ${res.status}: ${err}`)
  }

  const data = await res.json()

  if (!data.choices?.[0]?.message?.content) {
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`)
  }

  return data.choices[0].message.content
}

export async function callLLMJson(messages, model, apiKey) {
  const raw = await callLLM(messages, model, apiKey)

  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error(`LLM returned invalid JSON:\n${raw}`)
  }
}
