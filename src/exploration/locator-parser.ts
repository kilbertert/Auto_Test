import ts from 'typescript'
import type { LocatorIR } from '../core/types.js'

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return undefined
}

function booleanValue(node: ts.Expression | undefined): boolean | undefined {
  if (node?.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node?.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

function optionValue(object: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  const property = object?.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      ((ts.isIdentifier(item.name) && item.name.text === name) || (ts.isStringLiteral(item.name) && item.name.text === name)),
  )
  return property?.initializer
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return expression.name.text
  return undefined
}

export function parsePlaywrightLocator(expression: string): LocatorIR {
  const source = ts.createSourceFile(
    'locator.ts',
    `const candidate = ${expression}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  if (source.statements.length !== 1) throw new Error('CLI locator contains trailing statements')
  const statement = source.statements[0]
  if (!statement || !ts.isVariableStatement(statement)) throw new Error('CLI locator is not an expression')
  const initializer = statement.declarationList.declarations[0]?.initializer
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error('CLI locator must be a direct Playwright call')

  const method = callName(initializer.expression)
  const value = stringValue(initializer.arguments[0])
  if (!method || value === undefined) throw new Error('CLI locator contains unsupported arguments')
  const options = initializer.arguments[1] && ts.isObjectLiteralExpression(initializer.arguments[1])
    ? initializer.arguments[1]
    : undefined
  const exact = booleanValue(optionValue(options, 'exact'))

  switch (method) {
    case 'getByRole': {
      const name = stringValue(optionValue(options, 'name'))
      return {
        strategy: 'role',
        value,
        ...(name !== undefined ? { name } : {}),
        ...(exact !== undefined ? { exact } : {}),
        source: 'playwrightCli',
      }
    }
    case 'getByTestId':
      return { strategy: 'testId', value, source: 'playwrightCli' }
    case 'getByLabel':
      return { strategy: 'label', value, ...(exact !== undefined ? { exact } : {}), source: 'playwrightCli' }
    case 'getByPlaceholder':
      return { strategy: 'placeholder', value, ...(exact !== undefined ? { exact } : {}), source: 'playwrightCli' }
    case 'getByText':
      return { strategy: 'text', value, ...(exact !== undefined ? { exact } : {}), source: 'playwrightCli' }
    case 'locator':
      return value.startsWith('xpath=')
        ? { strategy: 'xpath', value: value.slice('xpath='.length), source: 'playwrightCli' }
        : { strategy: 'css', value, source: 'playwrightCli' }
    default:
      throw new Error(`Unsupported CLI locator method: ${method}`)
  }
}
