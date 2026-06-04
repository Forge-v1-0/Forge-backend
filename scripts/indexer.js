import axios from 'axios'
import { Project, SyntaxKind } from 'ts-morph'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const GITHUB_TOKEN = process.env.PAT_TOKEN
const REPO = process.env.CODER_REPOSITORY
const REPO_ID = process.env.REPO_ID

if (!REPO_ID) {
  console.error('REPO_ID env variable is required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { enabled: false }
})

function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj))
}

async function getDefaultBranch() {
  const res = await axios.get(
    `https://api.github.com/repos/${REPO}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json'
      }
    }
  )
  return res.data.default_branch
}

async function getRepoFiles() {
  const branch = await getDefaultBranch()
  const url = `https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json'
    }
  })
  return res.data.tree.filter(f => f.type === 'blob')
}

async function getFile(filePath) {
  const branch = await getDefaultBranch()
  const url = `https://raw.githubusercontent.com/${REPO}/${branch}/${filePath}`
  const res = await axios.get(url)
  return res.data
}

function detectLanguage(filePath) {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript'
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript'
  return null
}

function analyze(filePath, code, language) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      jsx: 2
    }
  })

  const source = project.createSourceFile(filePath, code)

  const imports = source.getImportDeclarations().map(i =>
    i.getModuleSpecifierValue()
  )

  const functions = source.getFunctions().map(fn => {
    const name = fn.getName() || 'anonymous'
    const calls = fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map(c => c.getExpression().getText())
    return { name, calls }
  })

  const arrowFunctions = source
    .getVariableDeclarations()
    .filter(v => {
      const init = v.getInitializer()
      return init && (
        init.getKind() === SyntaxKind.ArrowFunction ||
        init.getKind() === SyntaxKind.FunctionExpression
      )
    })
    .map(v => {
      const init = v.getInitializer()
      const calls = init
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .map(c => c.getExpression().getText())
      return { name: v.getName(), calls }
    })

  const allFunctions = [...functions, ...arrowFunctions]

  const exports = Array.from(source.getExportedDeclarations().keys())

  const routes = []
  const text = source.getFullText()
  const routeRegex = /(get|post|put|delete|patch)\(["'`](.*?)["'`]/g
  let match
  while ((match = routeRegex.exec(text)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2]
    })
  }

  return {
    imports,
    functions: allFunctions,
    exports,
    routes,
    language
  }
}

async function run() {
  console.log(`Starting index for repo: ${REPO} (id: ${REPO_ID})`)

  const files = await getRepoFiles()
  const targetFiles = files.filter(f => detectLanguage(f.path) !== null)

  console.log(`Found ${targetFiles.length} TS/JS files`)

  let success = 0
  let failed = 0

  for (const file of targetFiles) {
    const filePath = file.path
    const sha = file.sha
    const language = detectLanguage(filePath)

    console.log(`Indexing [${language}]: ${filePath}`)

    let code
    try {
      code = await getFile(filePath)
    } catch (err) {
      console.log(`Failed fetching: ${filePath}`)
      failed++
      continue
    }

    let data
    try {
      data = analyze(filePath, code, language)
    } catch (err) {
      console.log(`Failed parsing: ${filePath} — ${err.message}`)
      failed++
      continue
    }

    const { error } = await supabase.from('repo_index').upsert({
      repo_id: REPO_ID,
      path: filePath,
      sha,
      language,
      data: sanitize(data),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'repo_id,path'
    })

    if (error) {
      console.log(`Failed saving: ${filePath} — ${error.message}`)
      failed++
      continue
    }

    success++
  }

  console.log(`Index complete. Success: ${success} Failed: ${failed}`)
}

run()
