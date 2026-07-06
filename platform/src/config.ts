import { z } from 'zod'
import './env.js'

const EnvSchema = z.object({
  OMA_PROVIDER: z.string().default('anthropic'),
  OMA_API_KEY: z.string().optional(),
  OMA_BASE_URL: z.string().optional(),
  OMA_MODEL: z.string().default('claude-sonnet-4-6'),
  PORT: z.coerce.number().default(3000),
  BROWSER_HEADLESS: z.string().default('true'),
  BROWSER_POOL_SIZE: z.coerce.number().default(2),
  TARGET_LOGIN_URL: z.string().default('http://localhost:3000/fixture/login.html'),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[config] 环境变量校验失败:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  return parsed.data
}

const env = loadEnv()

export const config = {
  ...env,
  /** 浏览器是否无头(BROWSER_HEADLESS !== 'false' 即无头) */
  browserHeadless: env.BROWSER_HEADLESS !== 'false',
  /** 是否具备 LLM 凭据(agent 模式必需) */
  hasLlm: Boolean(env.OMA_API_KEY),
}
