import { describe, expect, it } from 'vitest'
import { validateFieldCompositionGate } from '../src/agent/field-composition.js'

describe('composite field representation gate', () => {
  it('blocks a static selector value repeated inside a secret input representation', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'contact-login',
      fieldId: 'contact-identity',
      logicalValueRef: 'workflow.contact',
      purpose: 'Enter one logical contact identity across visible controls',
      components: [
        { id: 'region', role: 'selector', label: 'Region', source: 'static', observedValue: 'R-7', representation: 'component', contribution: 'segment' },
        { id: 'identity', role: 'input', label: 'Identity', source: 'secret', representation: 'suffix', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'region', valueKind: 'static', literalValue: 'R-7' },
        { componentId: 'identity', valueKind: 'secret', valueLength: 12, secretAlias: 'AUTO_TEST_VALUE_001' },
      ],
      evidence: ['snapshot:contact-form'],
      secretValues: { AUTO_TEST_VALUE_001: 'R-7abcdefghi' },
    })

    expect(gate.status).toBe('blocked')
    expect(gate.reasons.join(' ')).toContain('do not reconstruct the logical source value')
  })

  it('passes a currency selector and component-specific amount representation', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'create-budget',
      fieldId: 'budget-value',
      logicalValueRef: 'workflow.budget',
      purpose: 'Enter a budget split across currency and amount controls',
      components: [
        { id: 'currency', role: 'selector', label: 'Currency', source: 'static', observedValue: 'CUR', representation: 'component', contribution: 'context' },
        { id: 'amount', role: 'input', label: 'Amount', source: 'secret', representation: 'component', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'currency', valueKind: 'static', literalValue: 'CUR' },
        { componentId: 'amount', valueKind: 'secret', valueLength: 6, secretAlias: 'AUTO_TEST_VALUE_001' },
      ],
      evidence: ['snapshot:budget-form'],
      secretValues: { AUTO_TEST_VALUE_001: '123400' },
    })

    expect(gate.status).toBe('passed')
    expect(gate.reasons).toEqual([])
  })

  it('blocks unknown date-time component semantics without recording raw derived values', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'schedule-job',
      fieldId: 'scheduled-at',
      logicalValueRef: 'workflow.scheduledAt',
      purpose: 'Represent a schedule across date and time-zone controls',
      components: [
        { id: 'zone', role: 'selector', label: 'Time zone', source: 'static', observedValue: 'Zone-A', representation: 'component', contribution: 'context' },
        { id: 'time', role: 'input', label: 'Local time', source: 'derived', representation: 'unknown', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'zone', valueKind: 'static', literalValue: 'Zone-A' },
        { componentId: 'time', valueKind: 'derived', valueLength: 16 },
      ],
      evidence: ['snapshot:schedule-form'],
    })

    expect(gate.status).toBe('blocked')
    expect(gate.reasons.join(' ')).toContain('unknown representation')
  })

  it('strips raw non-static values from a blocked gate record', () => {
    const rawSecret = 'must-not-persist'
    const gate = validateFieldCompositionGate({
      caseId: 'account-lookup',
      fieldId: 'account-identity',
      logicalValueRef: 'workflow.account',
      purpose: 'Represent an account identity across type and value controls',
      components: [
        { id: 'type', role: 'selector', label: 'Account type', source: 'static', observedValue: 'External', representation: 'component', contribution: 'context' },
        { id: 'account', role: 'input', label: 'Account', source: 'secret', observedValue: rawSecret, representation: 'component', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'type', valueKind: 'static', literalValue: 'External' },
        { componentId: 'account', valueKind: 'secret', valueLength: rawSecret.length, literalValue: rawSecret, secretAlias: 'AUTO_TEST_VALUE_001' },
      ],
      evidence: ['snapshot:account-form'],
      secretValues: { AUTO_TEST_VALUE_001: rawSecret },
    })

    expect(gate.status).toBe('blocked')
    expect(JSON.stringify(gate)).not.toContain(rawSecret)
  })

  it('passes a directly derived value when all segment components reconstruct the source', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'contact-login',
      fieldId: 'contact-identity',
      logicalValueRef: 'workflow.contact',
      purpose: 'Enter one logical contact identity across visible controls',
      components: [
        { id: 'region', role: 'selector', label: 'Region', source: 'static', observedValue: 'R-7', representation: 'component', contribution: 'segment' },
        { id: 'identity', role: 'input', label: 'Identity', source: 'secret', representation: 'suffix', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'region', valueKind: 'static', literalValue: 'R-7' },
        { componentId: 'identity', valueKind: 'derived', valueLength: 6, secretAlias: 'AUTO_TEST_VALUE_001', literalValue: 'abcdef' },
      ],
      evidence: ['snapshot:contact-form'],
      secretValues: {
        AUTO_TEST_VALUE_001: 'R-7abcdef',
      },
    })

    expect(gate.status).toBe('passed')
    expect(gate.reasons).toEqual([])
  })

  it('supports a composite value represented by multiple editable inputs', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'schedule-job',
      fieldId: 'schedule-window',
      logicalValueRef: 'workflow.scheduleWindow',
      purpose: 'Represent one schedule value across date and time inputs',
      components: [
        { id: 'date', role: 'input', label: 'Date', source: 'derived', representation: 'component', contribution: 'segment' },
        { id: 'time', role: 'input', label: 'Time', source: 'derived', representation: 'component', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'date', valueKind: 'derived', literalValue: '2026-08-02', secretAlias: 'AUTO_TEST_VALUE_001' },
        { componentId: 'time', valueKind: 'derived', literalValue: 'T21:15', secretAlias: 'AUTO_TEST_VALUE_001' },
      ],
      evidence: ['snapshot:schedule-window'],
      secretValues: { AUTO_TEST_VALUE_001: '2026-08-02T21:15' },
    })

    expect(gate.status).toBe('passed')
  })

  it('blocks a gate that has no authoritative logical source alias', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'name-entry',
      fieldId: 'display-name',
      logicalValueRef: 'workflow.displayName',
      purpose: 'Represent a display name across two inputs',
      components: [
        { id: 'first', role: 'input', label: 'First', source: 'derived', representation: 'component', contribution: 'segment' },
        { id: 'last', role: 'input', label: 'Last', source: 'derived', representation: 'component', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'first', valueKind: 'derived', literalValue: 'Test' },
        { componentId: 'last', valueKind: 'derived', literalValue: 'User' },
      ],
      evidence: ['snapshot:name-entry'],
    })

    expect(gate.status).toBe('blocked')
    expect(gate.reasons).toContain('composite field must reference exactly one logical source alias')
  })

  it('validates an explicitly empty logical value instead of skipping reconstruction', () => {
    const gate = validateFieldCompositionGate({
      caseId: 'empty-value',
      fieldId: 'composite-empty',
      logicalValueRef: 'workflow.empty',
      purpose: 'Represent an empty logical value across visible controls',
      components: [
        { id: 'mode', role: 'selector', label: 'Mode', source: 'static', observedValue: 'None', representation: 'component', contribution: 'context' },
        { id: 'value', role: 'input', label: 'Value', source: 'derived', representation: 'component', contribution: 'segment' },
      ],
      rendered: [
        { componentId: 'mode', valueKind: 'static', literalValue: 'None' },
        { componentId: 'value', valueKind: 'empty', literalValue: '', secretAlias: 'AUTO_TEST_VALUE_001' },
      ],
      evidence: ['snapshot:empty-value'],
      secretValues: { AUTO_TEST_VALUE_001: '' },
    })

    expect(gate.status).toBe('passed')
  })
})
