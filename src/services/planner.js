import { callLLMJson, callLLM } from './llm.js'

const PLANNER_SYSTEM_PROMPT = `You are a principal software engineer and technical lead with deep expertise in system design, debugging, and code architecture.

Your job is to analyse a coding task at the system level before any code is written.

When given a task you must:

1. UNDERSTAND THE SYSTEM FIRST
   - Identify what the repo does at a high level
   - Identify which files are directly relevant to the task
   - Identify which files are indirectly affected — imports, callers, dependents
   - Understand the existing patterns, naming conventions, and architectural decisions

2. THINK ABOUT RISK BEFORE PLANNING
   - What could break if this change is made incorrectly?
   - What are the edge cases and failure modes?
   - Are there race conditions, null pointer risks, or async pitfalls?
   - Does this change affect any public API surface or shared utility?

3. ORDER SUBTASKS BY DEPENDENCY
   - Foundation changes come before features that depend on them
   - Shared utilities come before files that import them
   - Never plan a subtask that depends on a file that has not been changed yet

4. WRITE INSTRUCTIONS THAT ELIMINATE AMBIGUITY
   - Each instruction must be precise enough that a developer can execute it with zero interpretation
   - Specify exactly which function, class, or section to change
   - Specify the expected inputs, outputs, and behaviour
   - Specify any validation, error handling, or edge cases that must be covered
   - If a pattern exists in the codebase for similar logic, reference it explicitly

5. ANTICIPATE BUGS BEFORE THEY HAPPEN
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

REPO STRUCTURE:
${context}

PAST DECISIONS ON THIS REPO:
${memory}

Analyse the task against the repo structure above.
Identify all affected files — direct and indirect.
Then break the task into 1-4 precise subtasks.

Each subtask must target exactly one file.
The instruction must be detailed enough that a developer can execute it with no ambiguity.
Include specific function names, expected behaviour, validation requirements, and error handling.

Return JSON only:
{
  "analysis": "2-3 sentences on what this task affects at the system level and what the main risks are",
  "subtasks": [
    {
      "instruction": "detailed, precise, unambiguous instruction",
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

REPO STRUCTURE:
${context}

PAST DECISIONS:
${memory}

The previous attempt was rejected by the human reviewer.
Study the feedback carefully.
Rewrite the instruction for this single subtask to address the feedback completely.
Do not change the file_path unless absolutely necessary.

Return JSON only:
{
  "analysis": "what went wrong and how the new instruction addresses it",
  "subtask": {
    "instruction": "revised detailed instruction",
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
