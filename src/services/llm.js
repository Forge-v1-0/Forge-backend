// llm.js
// All OpenRouter calls go through this module.

export const DEFAULT_MODELS = {
  planner: 'moonshotai/kimi-k2.6:free',
  coder: 'qwen/qwen3-coder:free'
}

// Max tokens we ask for. At 4000 the coder regularly truncates on large files.
const MAX_TOKENS = 8000

// Request timeout: OpenRouter free-tier models are slow but rarely need > 3min
const TIMEOUT_MS = 180_000

// ─── MARKDOWN CLEANUP ────────────────────────────────────────────
function stripMarkdownFences(text) {
  return text
    .replace(/^```[\w]*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/i, '')
    .trim()
}

// ─── TRUNCATION DETECTION ────────────────────────────────────────
// If finish_reason is 'length' the model hit max_tokens and the output is
// incomplete. Surfacing this explicitly prevents corrupt code from reaching
// the approval queue.
function assertNotTruncated(data, model) {
  const reason = data.choices?.[0]?.finish_reason
  if (reason === 'length') {
    throw new Error(
      `LLM output was truncated by ${model} (finish_reason=length). ` +
      'The model hit the token limit before completing the file. ' +
      'Try a model with a larger context window, or break the task into smaller subtasks.'
    )
  }
}

// ─── RETRY ───────────────────────────────────────────────────────
// Only retries on transient errors (rate limit / server error).
// Does NOT retry on auth errors or truncation — those need human action.
async function withRetry(fn, retries = 3, baseDelayMs = 1500) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err.message || ''
      const isTransient = msg.includes('429') || msg.includes('503') || msg.includes('502') || msg.includes('ECONNRESET')
      const isAuth = msg.includes('401') || msg.includes('403')
      const isTruncated = msg.includes('truncated')

      if (attempt === retries || isAuth || isTruncated) throw err
      if (!isTransient) throw err // non-transient, non-auth: fail fast

      const wait = baseDelayMs * Math.pow(2, attempt - 1)
      console.warn(`LLM attempt ${attempt}/${retries} failed: ${msg}. Retrying in ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

// ─── RAW CALL ────────────────────────────────────────────────────
async function callLLMRaw(messages, model, apiKey) {
  if (!apiKey) throw new Error('No OpenRouter API key provided')
  if (!model) throw new Error('No model specified')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/vitoraos/forge',
        'X-Title': 'forge'
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, temperature: 0.2, messages })
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${TIMEOUT_MS / 1000}s for model ${model}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) throw new Error('OpenRouter 401: API key is invalid or revoked. Re-save it in settings.')
  if (res.status === 402) throw new Error('OpenRouter 402: account has insufficient credits.')
  if (res.status === 429) throw new Error(`OpenRouter 429: rate limit hit on model ${model}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter ${res.status}: ${body}`)
  }

  const data = await res.json()
  if (!data.choices?.[0]?.message?.content) {
    throw new Error(`Unexpected OpenRouter response structure: ${JSON.stringify(data).slice(0, 300)}`)
  }

  assertNotTruncated(data, model)

  return stripMarkdownFences(data.choices[0].message.content)
}

// ─── EXPORTED WRAPPERS ───────────────────────────────────────────
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
    throw new Error(`LLM returned invalid JSON (model: ${model}):\n${raw.slice(0, 500)}`)
  }
}
