/**
 * Host-neutral model provider contract, shared by agent adapters, the workflow
 * layer (model profiles) and the compiler. Lives in core so lower layers never
 * have to reach into `agent/` for provider capability metadata.
 */
export const AGENT_MODEL_APIS = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-gemini-cli',
  'google-vertex',
] as const
export type AgentModelApi = typeof AGENT_MODEL_APIS[number]
export type AgentModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type AgentModelInputModality = 'text' | 'image'

export type AgentModelCredential =
  | { type: 'environment'; name: string }
  | { type: 'none' }

/** Host-neutral model endpoint selected once for an Auto-Test run. */
export interface AgentModelProviderDescriptor {
  profileId: string
  providerId: string
  model: string
  baseUrl: string
  api: AgentModelApi
  credential: AgentModelCredential
  displayName?: string
  reasoningEffort?: AgentModelReasoningEffort
  reasoningEfforts?: AgentModelReasoningEffort[]
  inputModalities?: AgentModelInputModality[]
  supportsParallelToolCalls?: boolean
  supportsSearchTool?: boolean
  serviceTier?: string
  supportsWebsockets?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
}
