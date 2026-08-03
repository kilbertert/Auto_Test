import { intakeWorkflowXlsx } from '../workflow/intake.js'
import { normalizeTargetUrls, targetOrigins } from './environment-registration.js'

export interface EasyWorkflowPreflight {
  targetUrls: string[]
  discoveredOrigins: string[]
}

export async function preflightEasyWorkflow(
  filePath: string,
  suppliedUrls: string[],
): Promise<EasyWorkflowPreflight> {
  const normalizedSuppliedUrls = normalizeTargetUrls(suppliedUrls)
  const intake = await intakeWorkflowXlsx({
    filePath,
    additionalUrls: normalizedSuppliedUrls,
  })
  const targetUrls = normalizeTargetUrls(intake.manifest.targetUrls)
  const suppliedOrigins = new Set(targetOrigins(normalizedSuppliedUrls))
  const discoveredOrigins = targetOrigins(targetUrls).filter((origin) => !suppliedOrigins.has(origin))
  return { targetUrls, discoveredOrigins }
}
