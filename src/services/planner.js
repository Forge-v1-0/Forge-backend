import { callLLMJson, callLLM } from './llm.js'

const PLANNER_SYSTEM_PROMPT = `You are a principal software engineer and technical lead with deep expertise in system design, debugging, and code architecture.

You are given a REPO GRAPH — a pre-computed, dense representation of the codebase that includes:
- File roles (page, layout, route, middleware, client, server, controller, service)
- Exported symbols per file (functions, components, hooks, classes)
- Component render tree (which components render which children)
- API surface (routes and middleware)
- Design system surface with component APIs: Button (path) {variant?, size?, loading?, disabled?, children}
- File dependencies (import graph)
- High-risk symbols (auth, database, crypto)

Your job is to analyse a coding task at the system level before any code is written.

When given a task you must:

1. READ THE GRAPH, NOT THE CODE
   - The context tells you exactly which files are pages, which are shared components, which handle auth
   - Use the render tree to understand component hierarchy
   - Use the API surface to understand backend entry points
   - Use the design system surface to know which UI primitives exist AND their props

2. USE THE DESIGN SYSTEM CORRECTLY
   - Every component in the Design System Surface has its props listed: {variant?, size?, loading?, disabled?, children}
   - A ? means the prop is optional. No ? means it is required.
   - Only use props that are listed. Do not invent props that are not in the component's API.
   - If you need a button, reference the exact path and exact props: "Use Button from src/components/ui/Button.jsx with variant='primary' and size='lg'"

3. IDENTIFY IMPACT USING THE GRAPH
   - If the task touches a shared component, trace the render tree to see which pages are affected
   - If the task touches a route handler, check middleware and auth flow dependencies
   - If the task touches a high-risk symbol (auth, database, crypto), flag it as high risk

4. ORDER SUBTASKS BY DEPENDENCY
   - Foundation changes come before features that depend on them
   - Shared utilities come before files that import them
   - Never plan a subtask that depends on a file that has not been changed yet

5. WRITE INSTRUCTIONS THAT ELIMINATE AMBIGUITY
   - Each instruction must be precise enough that a developer can execute it with zero interpretation
   - Specify exactly which function, class, or section to change
   - Specify the expected inputs, outputs, and behaviour
   - Specify any validation, error handling, or edge cases that must be covered
   - Reference existing patterns from the design system surface explicitly with exact props

6. ANTICIPATE BUGS BEFORE THEY HAPPEN
   - Flag any instruction that carries high risk of introducing a regression
   - If a change touches shared or critical code, note it as high risk
   - Prefer surgical changes over rewrites unless a rewrite is clearly necessary

Respond only with valid JSON. No markdown. No explanation outside the JSON.`

export async function runPlanner({
  task,
  context,
  memory,
  plannerModel,
  apiKey
}) {
  const userPrompt = `TASK: ${task}

REPO GRAPH:
${context}

PAST DECISIONS ON THIS REPO:
${memory}

Analyse the task against the repo graph above.
Use the render tree, API surface, and design system surface to identify exact impact.
Use ONLY the props listed for each component in the Design System Surface. Do not invent props.
Then break the task into 1-4 precise subtasks.

Each subtask must target exactly one file.
The instruction must reference existing symbols and patterns from the graph where possible, including exact component props.

Return JSON only:
{
  "analysis": "2-3 sentences on what this task affects at the system level and what the main risks are",
  "subtasks": [
    {
      "instruction": "detailed, precise, unambiguous instruction referencing existing patterns with exact props",
      "file_path": "path/to/file.ts",
      "risk": "low | medium | high",
      "risk_reason": "why this subtask carries risk if any"
    }
  ]
}`

  const result = await callLLMJson(
    [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    plannerModel,
    apiKey
  )

  return result
}

export async function replanSubtask({
  originalTask,
  originalInstruction,
  failedCode,
  feedback,
  context,
  memory,
  plannerModel,
  apiKey
}) {
  const userPrompt = `ORIGINAL TASK: ${originalTask}

ORIGINAL INSTRUCTION THAT FAILED:
${originalInstruction}

CODE THAT WAS REJECTED:
${failedCode}

HUMAN FEEDBACK:
${feedback}

REPO GRAPH:
${context}

PAST DECISIONS:
${memory}

The previous attempt was rejected by the human reviewer.
Study the feedback carefully.
Rewrite the instruction for this single subtask to address the feedback completely.
Use the repo graph to ensure the new instruction respects existing component boundaries, file roles, and exact component props.
Do not change the file_path unless absolutely necessary.

Return JSON only:
{
  "analysis": "what went wrong and how the new instruction addresses it",
  "subtask": {
    "instruction": "revised detailed instruction with exact component props",
    "file_path": "path/to/file.ts",
    "risk": "low | medium | high",
    "risk_reason": "updated risk assessment"
  }
}`

  const result = await callLLMJson(
    [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    plannerModel,
    apiKey
  )

  return result
}

export async function generateExplanation({
  instruction,
  originalContent,
  newContent,
  plannerModel,
  apiKey
}) {
  const prompt = `You are a senior engineer explaining a code change to a teammate.

TASK THAT WAS COMPLETED: ${instruction}

ORIGINAL FILE:
${originalContent || '(new file)'}

NEW FILE:
${newContent}

Write a clear, plain English explanation of:
1. What specifically changed and where
2. Why each change was made
3. Any edge cases or risks that were handled

Be specific. Reference function names where relevant.
Write for a developer who will review and approve this change.
Maximum 150 words. No markdown.`

  return callLLM(
    [{ role: 'user', content: prompt }],
    plannerModel,
    apiKey
  )
}
