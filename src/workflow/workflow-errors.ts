export class WorkflowPreActionError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error))
    this.name = 'WorkflowPreActionError'
  }
}

export function isWorkflowPreActionError(error: unknown): error is WorkflowPreActionError {
  return error instanceof WorkflowPreActionError
}
