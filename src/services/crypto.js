import crypto from 'crypto'

// ─── STARTUP GUARD ────────────────────────────────────────────────
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 16) {
  console.error('FATAL: ENCRYPTION_KEY env var is missing or shorter than 16 chars. Set it and restart.')
  process.exit(1)
}

const ALGORITHM = 'aes-256-cbc'
const KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()

export function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(stored) {
  const [ivHex, encryptedHex] = stored.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])
  return decrypted.toString('utf8')
}
