// src/services/llm.js
// All OpenRouter calls go through this module.

export const DEFAULT_MODELS = {
  planner: 'moonshotai/kimi-k2.6:free',
  coder: 'qwen/qwen3-coder:free'
}

const MAX_TOKENS_PLANNER = 8000
const MAX_TOKENS_CODER = 16000
const TIMEOUT_MS = 180_000

function stripMarkdownFences(text) {
  return text
    .replace(/^```[\w]*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/i, '')
    .trim()
}

function extractCodeFromReasoning(text) {
  if (!text) return ''
  const patterns = [
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<thought>[\s\S]*?<\/thought>/gi,
    /Thinking:[\s\S]*?(?=^```)/m
  ]
  let cleaned = text
  for (const p of patterns) cleaned = cleaned.replace(p, '')
  const codeBlock = cleaned.match(/```(?:\w+)?\n?([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  return cleaned.trim()
}

function assertNotTruncated(data, model) {
  const reason = data.choices?.[0]?.finish_reason
  if (reason === 'length') {
    throw new Error(`LLM output was truncated by ${model} (finish_reason=length). Try a smaller task or a model with a larger context window.`)
  }
}

async function withRetry(fn, retries = 3, baseDelayMs = 1500) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err.message || ''
      const isTransient = ['429','503','502','500','408','520','524','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE'].some(c => msg.includes(c))
      const isAuth = msg.includes('401') || msg.includes('402') || msg.includes('403')
      const isTruncated = msg.includes('truncated') || msg.includes('token limit')
      if (attempt === retries || isAuth || isTruncated) throw err
      if (!isTransient) throw err
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)))
    }
  }
  throw lastErr
}

async function callLLMRaw(messages, model, apiKey, ownerId = null, taskType = 'unknown') {
  if (!apiKey) throw new Error('No OpenRouter API key provided')
  if (!model) throw new Error('No model specified')

  const maxTokens = taskType === 'code' ? MAX_TOKENS_CODER : MAX_TOKENS_PLANNER

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
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages })
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`OpenRouter request timed out after ${TIMEOUT_MS / 1000}s for model ${model}`)
    throw err
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) throw new Error('OpenRouter 401: API key is invalid or revoked. Re-save it in settings.')
  if (res.status === 402) throw new Error('OpenRouter 402: Your account has insufficient credits. Please add credits at openrouter.ai or switch to a free model in settings.')
  if (res.status === 429) throw new Error(`OpenRouter 429: rate limit hit on model ${model}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter ${res.status}: ${body}`)
  }

  const data = await res.json()
  if (!data.choices?.[0]) throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(data).slice(0, 300)}`)

  const message = data.choices[0].message || {}
  let rawText = message.content

  // Extract from ANY field the model might use
  if (!rawText && message.reasoning) {
    rawText = message.reasoning
    console.warn(`Model ${model} returned reasoning field. Extracting code.`)
  }
  if (!rawText && message.reasoning_content) {
    rawText = message.reasoning_content
    console.warn(`Model ${model} returned reasoning_content field. Extracting code.`)
  }
  if (!rawText && message.reasoning_details?.length > 0) {
    rawText = message.reasoning_details.map(r => r.reasoning || r.text || r.content || '').filter(Boolean).join('\n')
    console.warn(`Model ${model} returned reasoning_details array. Extracting code.`)
  }

  if (!rawText) throw new Error(`No content or reasoning from model ${model}. Response: ${JSON.stringify(message).slice(0, 200)}`)

  // For coding: strip thinking, keep only code
  let finalText = rawText
  if (taskType === 'code') {
    finalText = extractCodeFromReasoning(rawText)
    if (!finalText) throw new Error(`Model ${model} returned thinking but no extractable code. Try a different model or smaller task.`)
  }

  assertNotTruncated(data, model)

  // Usage tracking
  if (ownerId && data.usage) {
    try {
      const { supabase } = await import('./supabase.js')
      await supabase.from('usage_logs').insert({
        user_id: ownerId, model: model,
        tokens_prompt: data.usage.prompt_tokens,
        tokens_completion: data.usage.completion_tokens,
        tokens_total: data.usage.total_tokens,
        created_at: new Date().toISOString()
      })
    } catch (e) { console.warn('Usage tracking failed:', e.message) }
  }

  return stripMarkdownFences(finalText)
}

export async function callLLM(messages, model, apiKey, ownerId) {
  return withRetry(() => callLLMRaw(messages, model, apiKey, ownerId, 'code'))
}

export async function callLLMJson(messages, model, apiKey, ownerId) {
  const raw = await withRetry(() => callLLMRaw(messages, model, apiKey, ownerId, 'plan'))
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
  let jsonText = cleaned
  const jsonBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonBlock) jsonText = jsonBlock[1].trim()
  const jsonObj = jsonText.match(/\{[\s\S]*\}/)
  if (jsonObj) jsonText = jsonObj[0]
  try { return JSON.parse(jsonText) } catch {
    throw new Error(`LLM returned invalid JSON (model: ${model}):\n${raw.slice(0, 500)}`)
  }
}
