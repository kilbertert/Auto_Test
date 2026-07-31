import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface CommandResult {
  stdout: string
  stderr: string
}

export interface StructuredModelCliOptions {
  codexExecutable: string
  codexArgs: string[]
  claudeExecutable: string
  prompt: string
  cwd: string
  timeoutMs: number
  outputSchemaPath: string
  allowClaudeFallback: boolean
  imagePaths?: string[]
}

export interface StructuredModelCliResult {
  output: string
  provider: 'codex-cli' | 'claude-cli'
}

function diagnosticTail(value: string, maxLength = 4_000): string {
  const trimmed = value.trim()
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(-maxLength)
}

function runCommand(
  executable: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  label: string,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        const diagnostic = diagnosticTail(result.stderr || result.stdout)
        reject(new Error(`${label} exited with ${code}: ${diagnostic || 'no diagnostic output'}`))
        return
      }
      resolvePromise(result)
    })
    child.stdin.end(input)
  })
}

function claudeCompatibleSchema(input: string): string {
  const schema = JSON.parse(input) as Record<string, unknown>
  delete schema.$schema
  return JSON.stringify(schema)
}

export function isModelCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /usage limit|purchase more credits|rate limit|quota|too many requests|\b429\b|overloaded|temporarily unavailable|model.*not available/i.test(message)
}

export function isExternalModelServiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return isModelCapacityError(error) || /(?:Codex model command|Claude fallback command).*(?:api[_ ]error|thinking block|reconnect|connection|timed out|timeout)/is.test(message)
}

export function parseClaudeStructuredOutput(output: string): string {
  const envelope = JSON.parse(output) as {
    is_error?: boolean
    api_error_status?: unknown
    result?: unknown
    structured_output?: unknown
  }
  if (envelope.is_error === true) {
    const detail = typeof envelope.result === 'string' && envelope.result.trim()
      ? envelope.result.trim()
      : String(envelope.api_error_status ?? 'unknown')
    throw new Error(`Claude fallback returned an error: ${diagnosticTail(detail, 1_000)}`)
  }
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return JSON.stringify(envelope.structured_output)
  }
  if (typeof envelope.result === 'string' && envelope.result.trim()) return envelope.result.trim()
  throw new Error('Claude fallback did not return structured output')
}

export async function runStructuredModelWithFallback(
  options: StructuredModelCliOptions,
): Promise<StructuredModelCliResult> {
  try {
    const result = await runCommand(
      options.codexExecutable,
      options.codexArgs,
      options.prompt,
      options.cwd,
      options.timeoutMs,
      'Codex model command',
    )
    return { output: result.stdout, provider: 'codex-cli' }
  } catch (error) {
    if (!options.allowClaudeFallback || !isModelCapacityError(error)) throw error
  }

  const imagePaths = options.imagePaths ?? []
  const schema = claudeCompatibleSchema(await readFile(options.outputSchemaPath, 'utf8'))
  const args = [
    '-p',
    '--safe-mode',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', schema,
    '--tools', imagePaths.length > 0 ? 'Read' : '',
  ]
  for (const directory of [...new Set(imagePaths.map(dirname))]) args.push('--add-dir', directory)
  const imageNote = imagePaths.length === 0
    ? ''
    : [
        '',
        'MODEL ADAPTER NOTE:',
        'The primary image adapter is unavailable. You may use the Read tool only for the exact image paths below.',
        'Do not inspect any other filesystem path and do not use any other tool.',
        ...imagePaths.map((path) => `- ${path}`),
      ].join('\n')
  const result = await runCommand(
    options.claudeExecutable,
    args,
    `${options.prompt}${imageNote}`,
    options.cwd,
    options.timeoutMs,
    'Claude fallback command',
  )
  return { output: parseClaudeStructuredOutput(result.stdout), provider: 'claude-cli' }
}
