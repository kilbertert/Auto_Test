export type LocatorStrategy =
  | 'role'
  | 'testId'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'css'
  | 'xpath'

export interface LocatorIR {
  strategy: LocatorStrategy
  value: string
  name?: string
  exact?: boolean
  source: 'manual' | 'playwrightCli' | 'aiSuggested'
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  severity: DiagnosticSeverity
  code: string
  message: string
  sheet?: string
  row?: number
  column?: string
  caseId?: string
  path?: string
}
