import crypto from 'crypto'

// ─── STARTUP GUARD ────────────────────────────────────────────────
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  console.error('FATAL: ENCRYPTION_KEY env var is missing or shorter than 32 chars. Set it and restart.')
  process.exit(1)
}

const ALGORITHM = 'aes-256-cbc'
const KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()

// Strict regex to ensure the stored value is exactly 32 hex chars, a colon, and more hex chars
const STORED_RE = /^[0-9a-f]{32}:[0-9a-f]+$/i

export function encrypt(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('encrypt: text must be a non-empty string')
  }
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(stored) {
  // 1. Catch nulls/undefined immediately with a clear message
  if (typeof stored !== 'string') {
    throw new Error('decrypt: stored value is not a string — credential may be missing or corrupt')
  }

  // 2. Catch plain-text legacy values BEFORE calling Buffer.from
  if (!STORED_RE.test(stored)) {
    throw new Error(
      'decrypt: stored value does not match expected format iv:ciphertext. ' +
      'The credential is likely a legacy plaintext value. Please re-add the repo in the UI.'
    )
  }

  // 3. Safely parse the string
  const colonIdx = stored.indexOf(':')
  const ivHex = stored.slice(0, colonIdx)
  const encryptedHex = stored.slice(colonIdx + 1)

  const iv = Buffer.from(ivHex, 'hex')
  const encryptedBuf = Buffer.from(encryptedHex, 'hex')

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()])
    return decrypted.toString('utf8')
  } catch (err) {
    throw new Error(
      'decrypt: decryption failed — the credential was likely encrypted with a different ENCRYPTION_KEY. ' +
      'Please re-save your credentials in settings.'
    )
  }
}
