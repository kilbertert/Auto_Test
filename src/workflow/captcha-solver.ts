import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runStructuredModelWithFallback } from './structured-model-cli.js'

export interface WorkflowCaptchaSolver {
  readonly name: string
  solve(image: Buffer): Promise<string>
}

export class CodexCliWorkflowCaptchaSolver implements WorkflowCaptchaSolver {
  readonly name = 'codex-cli+claude-cli-fallback'

  constructor(private readonly options: {
    executable?: string
    fallbackExecutable?: string
    model?: string
    timeoutMs?: number
    outputSchemaPath?: string
  } = {}) {}

  async solve(image: Buffer): Promise<string> {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-captcha-'))
    await chmod(directory, 0o700)
    const imagePath = resolve(directory, 'captcha.png')
    const schemaPath = resolve(this.options.outputSchemaPath ?? 'schemas/workflow-captcha-response.schema.json')
    try {
      await writeFile(imagePath, image, { mode: 0o600 })
      await chmod(imagePath, 0o600)
      const args = [
        'exec', '-', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-rules',
        '--color', 'never', '--output-schema', schemaPath, '-C', directory, '--image', imagePath,
      ]
      if (this.options.model) args.push('--model', this.options.model)
      const result = await runStructuredModelWithFallback({
        codexExecutable: this.options.executable ?? 'codex',
        codexArgs: args,
        claudeExecutable: this.options.fallbackExecutable ?? 'claude',
        prompt: 'Transcribe only the exact alphanumeric captcha visible in the supplied image. Preserve letter case. Return the structured code field. Do not describe the image.',
        cwd: directory,
        timeoutMs: this.options.timeoutMs ?? 3 * 60_000,
        outputSchemaPath: schemaPath,
        allowClaudeFallback: true,
        imagePaths: [imagePath],
      })
      const parsed = JSON.parse(result.output) as { code?: unknown }
      if (typeof parsed.code !== 'string' || !/^[A-Za-z0-9]{4,8}$/.test(parsed.code)) {
        throw new Error('Captcha solver returned an invalid code shape')
      }
      return parsed.code
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
