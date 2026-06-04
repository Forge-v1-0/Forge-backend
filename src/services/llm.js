export const DEFAULT_MODELS = {
  planner: 'moonshotai/kimi-k2.6:free',
  coder: 'qwen/qwen3-coder:free'
}

// ─── MARKDOWN CLEANUP ─────────────────────────────────────────────
function stripMarkdownFences(text) {
  return text
    .replace(/^```[\w]*\n?/i, '')  // opening fence with optional language tag
    .replace(/\n?```\s*$/i, '')     // closing fence
    .trim()
}

// ─── RETRY LOGIC ──────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isRateLimit = err.message.includes('429') || err.message.includes('503')
      const isLastAttempt = attempt === retries

      if (isLastAttempt) throw err

      const wait = isRateLimit
        ? delayMs * Math.pow(2, attempt)  // exponential backoff on rate limits
        : delayMs                          // fixed delay on other errors

      console.warn(`Attempt ${attempt} failed: ${err.message}. Retrying in ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

// ─── RAW LLM CALL ─────────────────────────────────────────────────
async function callLLMRaw(messages, model, apiKey) {
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
  
  // Strip markdown fences before returning
  return stripMarkdownFences(data.choices[0].message.content)
}

// ─── EXPORTED WRAPPERS ────────────────────────────────────────────
export async function callLLM(messages, model, apiKey) {
  return withRetry(() => callLLMRaw(messages, model, apiKey))
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
