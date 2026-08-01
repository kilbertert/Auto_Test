import type { Diagnostic, DiagnosticSeverity } from './types.js'

export class DiagnosticBag {
  readonly items: Diagnostic[] = []

  add(severity: DiagnosticSeverity, code: string, message: string, context: Omit<Diagnostic, 'severity' | 'code' | 'message'> = {}): void {
    this.items.push({ severity, code, message, ...context })
  }

  error(code: string, message: string, context: Omit<Diagnostic, 'severity' | 'code' | 'message'> = {}): void {
    this.add('error', code, message, context)
  }

  warning(code: string, message: string, context: Omit<Diagnostic, 'severity' | 'code' | 'message'> = {}): void {
    this.add('warning', code, message, context)
  }

  info(code: string, message: string, context: Omit<Diagnostic, 'severity' | 'code' | 'message'> = {}): void {
    this.add('info', code, message, context)
  }

  count(severity: DiagnosticSeverity): number {
    return this.items.filter((item) => item.severity === severity).length
  }

  get hasErrors(): boolean {
    return this.items.some((item) => item.severity === 'error')
  }
}
