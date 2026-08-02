import type { CodexTestFieldCompositionGate, CodexTestFieldComponent, CodexTestFieldRenderedComponent } from './types.js'

export function validateFieldCompositionGate(input: {
  caseId: string
  fieldId: string
  logicalValueRef: string
  purpose: string
  components: CodexTestFieldComponent[]
  rendered: CodexTestFieldRenderedComponent[]
  evidence: string[]
  secretValues?: Record<string, string>
}): CodexTestFieldCompositionGate {
  const components = input.components
  const sanitizedComponents = components.map((component) => component.source === 'static'
    ? component
    : { ...component, observedValue: undefined })
  const sanitizedRendered = input.rendered.map((component) => component.valueKind === 'static'
    ? component
    : { ...component, literalValue: undefined })
  const renderedIds = new Set(input.rendered.map((component) => component.componentId))
  const hasSecretAlias = (alias: string) => Object.prototype.hasOwnProperty.call(input.secretValues ?? {}, alias)
  const reasons: string[] = []
  if (components.length < 2) reasons.push('composite field must describe at least two visible components')
  if (new Set(components.map((component) => component.id)).size !== components.length) reasons.push('composite field component IDs must be unique')
  if (renderedIds.size !== input.rendered.length) reasons.push('rendered composite field component IDs must be unique')
  if (!components.some((component) => component.role === 'input')) reasons.push('composite field must contain an editable input component')
  if (input.evidence.length === 0) reasons.push('composite field requires page evidence')
  for (const component of components) {
    if (!component.id.trim() || !component.label.trim()) reasons.push('composite field components require stable IDs and labels')
    if (component.source === 'static' && !component.observedValue?.trim()) reasons.push(`static component ${component.id} must record its observed value`)
    if (component.source !== 'static' && component.observedValue !== undefined) reasons.push(`secret or derived component ${component.id} must not record a raw observed value`)
    if (component.representation === 'unknown') reasons.push(`component ${component.id} has an unknown representation`)
  }
  for (const rendered of input.rendered) {
    const definition = components.find((component) => component.id === rendered.componentId)
    if (!definition) reasons.push(`rendered value references unknown component ${rendered.componentId}`)
    if (rendered.valueKind === 'secret' && rendered.literalValue !== undefined) reasons.push(`secret component ${rendered.componentId} must not expose a raw value`)
    if (['secret', 'derived'].includes(rendered.valueKind) && !rendered.secretAlias) reasons.push(`secret-derived component ${rendered.componentId} must identify its source alias`)
    if (rendered.valueKind === 'derived' && rendered.literalValue === undefined) reasons.push(`derived component ${rendered.componentId} must provide the rendered component value for private validation`)
    if (definition?.source === 'static' && rendered.valueKind !== 'static') reasons.push(`static component ${rendered.componentId} must remain static after filling`)
    if (definition?.source === 'static' && rendered.literalValue?.trim() !== definition.observedValue?.trim()) reasons.push(`static component ${rendered.componentId} changed after filling`)
    if (definition?.source !== 'static' && rendered.valueKind === 'static') reasons.push(`non-static component ${rendered.componentId} was incorrectly reported as static`)
    if (rendered.secretAlias && !hasSecretAlias(rendered.secretAlias)) reasons.push(`secret alias ${rendered.secretAlias} is unavailable to the field gate`)
    const renderedValue = rendered.valueKind === 'secret'
      ? (rendered.secretAlias ? input.secretValues?.[rendered.secretAlias] : undefined)
      : rendered.literalValue
    if (rendered.valueLength !== undefined && renderedValue !== undefined && rendered.valueLength !== renderedValue.length) {
      reasons.push(`component ${rendered.componentId} length does not match its rendered value`)
    }
  }
  for (const component of components) if (!renderedIds.has(component.id)) reasons.push(`component ${component.id} has no post-fill rendered observation`)
  const sourceAliases = [...new Set(input.rendered.flatMap((component) => component.secretAlias ? [component.secretAlias] : []))]
  if (sourceAliases.length !== 1) reasons.push('composite field must reference exactly one logical source alias')
  const sourceAlias = sourceAliases[0]
  const sourceValue = sourceAlias && hasSecretAlias(sourceAlias) ? input.secretValues?.[sourceAlias] : undefined
  if (sourceValue !== undefined) {
    const renderedById = new Map(input.rendered.map((component) => [component.componentId, component]))
    const reconstructed = components.filter((component) => component.contribution === 'segment').map((component) => {
      const rendered = renderedById.get(component.id)
      if (!rendered) return ''
      if (rendered.valueKind === 'secret') return rendered.secretAlias ? input.secretValues?.[rendered.secretAlias] ?? '' : ''
      return rendered.literalValue ?? ''
    }).join('')
    if (reconstructed.normalize('NFKC') !== sourceValue.normalize('NFKC')) {
      reasons.push('rendered segment components do not reconstruct the logical source value exactly')
    }
  }
  return {
    id: `${input.caseId}:${input.fieldId}`,
    caseId: input.caseId,
    fieldId: input.fieldId,
    logicalValueRef: input.logicalValueRef,
    purpose: input.purpose,
    components: sanitizedComponents,
    rendered: sanitizedRendered,
    evidence: [...new Set(input.evidence)],
    status: reasons.length === 0 ? 'passed' : 'blocked',
    reasons: [...new Set(reasons)],
    checkedAt: new Date().toISOString(),
  }
}
