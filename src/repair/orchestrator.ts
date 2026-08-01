import { createHash } from 'node:crypto'
import type { TestSuiteIR } from '../core/types.js'
import type { LocatorCandidateReport } from '../exploration/types.js'
import {
  validateLocators,
  type LocatorValidationOptions,
  type LocatorValidationReport,
} from '../validation/locator-validator.js'
import { classifyFailures } from './classifier.js'
import { applyRepairChanges, planRepairs } from './planner.js'
import type { BoundedRepairResult, RepairAttemptReport } from './types.js'

export interface BoundedRepairOptions extends LocatorValidationOptions {
  maxAttempts?: number
}

function suiteHash(suite: TestSuiteIR): string {
  return createHash('sha256').update(JSON.stringify(suite)).digest('hex')
}

function passed(report: LocatorValidationReport): boolean {
  return report.summary.failed === 0 && report.summary.blocked === 0
}

export async function runBoundedRepair(
  input: TestSuiteIR,
  candidates: LocatorCandidateReport[],
  options: BoundedRepairOptions = {},
): Promise<BoundedRepairResult> {
  const policyMaximum = input.policy.repair.maxAttempts
  const requestedMaximum = options.maxAttempts ?? policyMaximum
  if (!Number.isInteger(requestedMaximum) || requestedMaximum < 0 || requestedMaximum > 2) {
    throw new Error('maxAttempts must be an integer from 0 to 2')
  }
  const maxAttempts = Math.min(policyMaximum, requestedMaximum)
  const validationOptions: LocatorValidationOptions = {
    ...(options.caseIds ? { caseIds: options.caseIds } : {}),
    ...(options.replays !== undefined ? { replays: options.replays } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {}),
    ...(options.allowWrite !== undefined ? { allowWrite: options.allowWrite } : {}),
    ...(options.allowDestructive !== undefined ? { allowDestructive: options.allowDestructive } : {}),
  }
  const baselineValidation = await validateLocators(input, validationOptions)
  const baselineClassification = classifyFailures(input, baselineValidation)
  const inputHash = suiteHash(input)
  if (passed(baselineValidation)) {
    return {
      report: {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        suiteId: input.suiteId,
        maxAttempts,
        baseline: { irSha256: inputHash, validation: baselineValidation, classification: baselineClassification },
        attempts: [],
        finalStatus: 'already_passed',
        finalIrSha256: inputHash,
      },
      finalSuite: structuredClone(input),
    }
  }

  let currentSuite = structuredClone(input)
  let currentClassification = baselineClassification
  const attempts: RepairAttemptReport[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const changes = planRepairs(currentSuite, currentClassification, candidates)
    if (changes.length === 0) break
    const beforeHash = suiteHash(currentSuite)
    const nextSuite = applyRepairChanges(currentSuite, changes)
    const validation = await validateLocators(nextSuite, validationOptions)
    const classification = classifyFailures(nextSuite, validation)
    const attemptReport: RepairAttemptReport = {
      attempt,
      inputIrSha256: beforeHash,
      outputIrSha256: suiteHash(nextSuite),
      changes,
      validation,
      classification,
      status: passed(validation) ? 'passed' : 'failed',
    }
    attempts.push(attemptReport)
    currentSuite = nextSuite
    currentClassification = classification
    if (attemptReport.status === 'passed') {
      return {
        report: {
          version: '1.0',
          generatedAt: new Date().toISOString(),
          suiteId: input.suiteId,
          maxAttempts,
          baseline: { irSha256: inputHash, validation: baselineValidation, classification: baselineClassification },
          attempts,
          finalStatus: 'repaired',
          finalIrSha256: attemptReport.outputIrSha256,
        },
        finalSuite: currentSuite,
      }
    }
  }

  return {
    report: {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      suiteId: input.suiteId,
      maxAttempts,
      baseline: { irSha256: inputHash, validation: baselineValidation, classification: baselineClassification },
      attempts,
      finalStatus: 'unrepaired',
      finalIrSha256: suiteHash(currentSuite),
    },
  }
}
