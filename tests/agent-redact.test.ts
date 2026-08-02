import { describe, expect, it } from 'vitest'
import { transientAgentEventValues } from '../src/agent/redact.js'

describe('agent event redaction', () => {
  it('extracts transient composite-field values without treating unrelated tool arguments as secrets', () => {
    expect(transientAgentEventValues({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        tool: 'field_composition_check',
        arguments: {
          rendered: [
            { componentId: 'selector', valueKind: 'derived', literalValue: 'segment-a' },
            { componentId: 'input', valueKind: 'derived', literalValue: 'segment-b' },
          ],
        },
      },
    })).toEqual(['segment-a', 'segment-b'])

    expect(transientAgentEventValues({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', tool: 'browser_fill_form', arguments: { value: 'visible-to-existing-redaction' } },
    })).toEqual([])
  })
})
