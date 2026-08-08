import { type EnvironmentProfile } from '../workflow/environment-profile.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
import {
  environmentProfileMatches,
  normalizeTargetUrls,
  targetOrigins,
  type EnvironmentProfileMatch,
} from './environment-registration.js'

export interface EasyWorkflowPreflight {
  targetUrls: string[]
  materialOrigins: string[]
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
  const materialOrigins = targetOrigins(targetUrls).filter((origin) => !suppliedOrigins.has(origin))
  return { targetUrls, materialOrigins }
}

export interface EasyRegistrationDefaults {
  profileId?: string
  existingProfile?: EnvironmentProfile
}

export type EasyRegistrationPlan =
  | { kind: 'use'; profileId: string }
  | { kind: 'choose'; profiles: EnvironmentProfile[] }
  | {
      kind: 'register'
      registrationUrls: string[]
      defaults: EasyRegistrationDefaults
      related?: EnvironmentProfileMatch[]
      message: string
    }
  | { kind: 'error'; message: string }

/**
 * Decide how the easy workflow should obtain a registered environment.
 *
 * Registration and login are scoped to the URLs the user explicitly pasted
 * (`suppliedUrls`). Origins merely discovered in the test-case workbook are
 * retained by `preflightEasyWorkflow` as material context and never expand the
 * registration requirement, so incidental external references cannot block a run.
 */
export async function planEasyRegistration(params: {
  suppliedUrls: string[]
  profileId?: string
  isTTY: boolean
  registryPath?: string
}): Promise<EasyRegistrationPlan> {
  const registrationUrls = normalizeTargetUrls(params.suppliedUrls)
  if (registrationUrls.length === 0) {
    return { kind: 'error', message: '新 AgentHost Run 必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文' }
  }
  const profileMatches = await environmentProfileMatches(registrationUrls, params.registryPath)
  if (params.profileId) {
    const requested = profileMatches.find((match) => match.profile.id === params.profileId)
    if (!requested) return { kind: 'error', message: `未找到环境：${params.profileId}` }
    if (requested.missingOrigins.length === 0) return { kind: 'use', profileId: params.profileId }
    if (!params.isTTY) return { kind: 'error', message: profileCoverageError(requested) }
    return {
      kind: 'register',
      registrationUrls,
      defaults: { existingProfile: requested.profile },
      message: `环境“${params.profileId}”尚未覆盖：${requested.missingOrigins.join('、')}\n现在进入环境更新向导；直接使用默认选项会保留已有登录状态和权限范围。`,
    }
  }
  const profiles = profileMatches
    .filter((match) => match.missingOrigins.length === 0)
    .map((match) => match.profile)
  if (profiles.length === 1) return { kind: 'use', profileId: profiles[0]!.id }
  if (profiles.length > 1) return { kind: 'choose', profiles }
  if (params.isTTY) {
    const related = profileMatches
      .filter((match) => match.coveredOrigins.length > 0)
      .sort((left, right) =>
        left.missingOrigins.length - right.missingOrigins.length || left.profile.id.localeCompare(right.profile.id),
      )
    if (related.length > 0) {
      return {
        kind: 'register',
        registrationUrls,
        defaults: related.length === 1 ? { existingProfile: related[0]!.profile } : {},
        related,
        message:
          '已有环境尚未覆盖测试用例需要的全部网站：\n' +
          related.map((match) => `  ${match.profile.id}：缺少 ${match.missingOrigins.join('、')}`).join('\n') +
          '\n现在进入环境更新向导；直接使用默认选项会保留已有登录状态和权限范围。',
      }
    }
    return {
      kind: 'register',
      registrationUrls,
      defaults: {},
      message: '这些网站尚未注册，先用向导完成一次环境注册。',
    }
  }
  return { kind: 'error', message: profileRegistrationError(profileMatches, registrationUrls) }
}

export function profileCoverageError(match: EnvironmentProfileMatch): string {
  return `环境“${match.profile.id}”缺少网站：${match.missingOrigins.join('、')}`
}

export function profileRegistrationError(matches: EnvironmentProfileMatch[], urls: string[]): string {
  const related = matches.find((match) => match.coveredOrigins.length > 0)
  if (related) return `${profileCoverageError(related)}。请先运行 npm run easy，选择“注册或更新测试环境”。`
  const origins = [...new Set(urls.map((url) => new URL(url).origin))]
  return `以下网站尚未注册：${origins.join('、')}。请先运行 npm run easy，选择“注册或更新测试环境”。`
}
