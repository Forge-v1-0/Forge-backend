import crypto from 'crypto'

const ALGORITHM = 'aes-256-cbc'

// ─── STARTUP GUARD ────────────────────────────────────────────────
// If ENCRYPTION_KEY is absent the process must not start — every encrypted
// credential in the DB would use SHA-256(""), a known public value.
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 16) {
  console.error('FATAL: ENCRYPTION_KEY env var is missing or shorter than 16 chars. Set it and restart.')
  process.exit(1)
}

const KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()

// Stored format: <16-byte-iv-hex>:<ciphertext-hex>
// The colon is the separator. IV is always exactly 32 hex chars (16 bytes).
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
  // Reject nulls, plaintext legacy values, and malformed strings before
  // touching Buffer — avoids cryptic internal errors leaking to users.
  if (typeof stored !== 'string') {
    throw new Error('decrypt: stored value is not a string — credential may be missing or corrupt')
  }
  if (!STORED_RE.test(stored)) {
    throw new Error(
      'decrypt: stored value does not match expected format iv:ciphertext. ' +
      'The credential may be a legacy plaintext value or was stored with a different ENCRYPTION_KEY. ' +
      'Please re-save your credentials in settings.'
    )
  }
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
