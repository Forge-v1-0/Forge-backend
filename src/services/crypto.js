import crypto from 'crypto'

const ALGORITHM = 'aes-256-cbc'
const KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || '').digest()

export function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ])
  // Store iv + encrypted together so we can decrypt later
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
