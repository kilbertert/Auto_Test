import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import formatsPlugin from 'ajv-formats'
import type { Diagnostic, TestSuiteIR } from '../core/types.js'

const schemaPath = resolve(process.cwd(), 'schemas/test-case-ir.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
const addFormats = formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020
addFormats(ajv)
const validate = ajv.compile<TestSuiteIR>(schema)

function errorMessage(error: ErrorObject): string {
  const location = error.instancePath || '/'
  return `${location} ${error.message ?? 'schema validation failed'}`
}

export function validateSuite(suite: unknown): { valid: boolean; diagnostics: Diagnostic[] } {
  const valid = validate(suite)
  if (valid) return { valid: true, diagnostics: [] }
  return {
    valid: false,
    diagnostics: (validate.errors ?? []).map((error: ErrorObject) => ({
      severity: 'error',
      code: 'schema_validation',
      message: errorMessage(error),
      path: error.instancePath || '/',
    })),
  }
}
