import { createClient } from '@supabase/supabase-js'

if (!process.env.SUPABASE_URL) {
  console.error('FATAL: SUPABASE_URL env var is not set.')
  process.exit(1)
}
if (!process.env.SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_KEY env var is not set.')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

export default supabase
