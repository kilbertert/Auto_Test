import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { openRunArtifactStore } from '../src/agent/run-artifact-store.js'
import type { CodexTestAgentState, CodexTestMutationLedgerEntry } from '../src/agent/types.js'
import { startObservationServer, type ObservationServer } from '../src/observe/server.js'

/**
 * The observation plane projecting a run whose AgentHost never delivered a
 * result. Its business-residue line is the Mutation Ledger as the
 * RunArtifactStore reads it back, and nothing else from that private journal
 * crosses the read-only boundary.
 */
const servers: ObservationServer[] = []
const SECRET_MARKER = 'OBS-JOURNAL-SECRET-MARKER'

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'catalog',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
  targetUrls: ['https://catalog.example.test/'],
  requiredCapabilities: [],
  phases: [{
    id: 'place-order',
    title: 'Place order',
    sourceRow: 2,
    risk: 'write',
    steps: [],
    resources: [],
    secretBindings: [],
    imageIds: [],
    review: { status: 'draft', ambiguities: [] },
  }],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

function ledgerEntry(overrides: Partial<CodexTestMutationLedgerEntry> = {}): CodexTestMutationLedgerEntry {
  return {
    id: 'create-order',
    caseId: 'place-order',
    description: `未完成写入 ${SECRET_MARKER}`,
    risk: 'write',
    status: 'pending',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:30.000Z',
    evidence: [],
    ...overrides,
  }
}

/** One run directory whose AgentHost failed mid-run: state, manifest, and journal. */
async function writeFailedRun(runRoot: string, ledger: CodexTestMutationLedgerEntry[] | undefined): Promise<string> {
  const runId = '20260901-080000-catalog-abc12'
  const runDirectory = resolve(runRoot, runId)
  await mkdir(resolve(runDirectory, '.agent-private'), { recursive: true })
  if (ledger) {
    await writeFile(resolve(runDirectory, '.agent-private', 'mutation-ledger.json'), JSON.stringify(ledger))
  }
  await mkdir(resolve(runDirectory, 'agent-workspace'), { recursive: true })
  await writeFile(resolve(runDirectory, 'agent-workspace', 'test-manifest.json'), JSON.stringify(manifest))
  await writeFile(resolve(runDirectory, 'codex-agent.events.jsonl'), '{}\n')
  const state: CodexTestAgentState = {
    version: '2.0',
    status: 'failed',
    stage: 'failed',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    startedAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:01:00.000Z',
    threadGeneration: 0,
    completedCaseIds: [],
    error: 'browser process exited',
  }
  await writeFile(resolve(runDirectory, 'codex-agent.state.json'), JSON.stringify(state))
  return runId
}

async function observationDetail(runRoot: string, runId: string): Promise<{ status: number; body: string; lines: string[] }> {
  const server = await startObservationServer({ runRoot })
  servers.push(server)
  const response = await fetch(`${server.baseUrl}/api/runs/${runId}`)
  const body = await response.text()
  const detail = JSON.parse(body) as { summary: { outcome: string; lines: string[] } }
  return { status: response.status, body, lines: detail.summary.lines }
}

describe('observation plane run journal projection', () => {
  it('projects business residue from the same entries the store reads', async () => {
    const runRoot = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-journal-'))
    try {
      const runId = await writeFailedRun(runRoot, [ledgerEntry(), ledgerEntry({ id: 'cancel-order', status: 'compensated' })])

      const { status, lines } = await observationDetail(runRoot, runId)

      expect(status).toBe(200)
      expect(lines).toContain('业务残留：1 项 Mutation 仍为 pending，继续前必须先核对或恢复。')
      // The projected count is the store's own reading of the journal, not a second one.
      const journal = await openRunArtifactStore({ runRoot: resolve(runRoot, runId), manifest }).readMutationLedger()
      expect(journal.problems).toEqual([])
      expect(journal.entries.filter((entry) => entry.status === 'pending')).toHaveLength(1)
    } finally {
      await rm(runRoot, { recursive: true, force: true })
    }
  })

  it.each([
    {
      journal: 'one unresolved mutation',
      ledger: [ledgerEntry()],
      line: '业务残留：1 项 Mutation 仍为 pending，继续前必须先核对或恢复。',
    },
    {
      journal: 'one compensated mutation',
      ledger: [ledgerEntry({ status: 'compensated' })],
      line: '业务残留：无未核销写入，Mutation Ledger pending=0。',
    },
    {
      journal: 'an empty journal',
      ledger: [] as CodexTestMutationLedgerEntry[],
      line: '业务残留：Mutation Ledger 未记录待恢复写入（pending=0）。',
    },
    {
      journal: 'no journal at all',
      ledger: undefined,
      line: '业务残留：无法从当前结果确认，请先查看运行诊断。',
    },
    {
      journal: 'a journal naming a Case outside the persisted manifest',
      ledger: [ledgerEntry({ caseId: 'not-in-manifest' })],
      line: '业务残留：无法从当前结果确认，请先查看运行诊断。',
    },
  ])('projects business residue from $journal', async ({ ledger, line }) => {
    const runRoot = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-journal-'))
    try {
      const runId = await writeFailedRun(runRoot, ledger)

      const { status, lines } = await observationDetail(runRoot, runId)

      expect(status).toBe(200)
      expect(lines).toContain(line)
    } finally {
      await rm(runRoot, { recursive: true, force: true })
    }
  })

  it('keeps private journal content and paths out of the read-only payload', async () => {
    const runRoot = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-journal-'))
    try {
      const runId = await writeFailedRun(runRoot, [ledgerEntry()])

      const { body, lines } = await observationDetail(runRoot, runId)

      // The projection counts what it read; it never replays a private journal.
      expect(body).not.toContain(SECRET_MARKER)
      expect(body).not.toContain('.agent-private')
      expect(body).not.toContain('mutation-ledger')
      expect(lines.join(' ')).not.toContain(SECRET_MARKER)
    } finally {
      await rm(runRoot, { recursive: true, force: true })
    }
  })
})
