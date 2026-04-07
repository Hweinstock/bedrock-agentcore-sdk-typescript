/**
 * Integration tests for MemoryClient
 *
 * Requires:
 * - AWS credentials configured
 * - AgentCore Memory service available in the region
 *
 * These tests are sequential — each depends on state from the previous.
 * Memory creation takes ~160s, deletion ~30s. The 600s suite timeout
 * accommodates worst-case polling for both.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MemoryClient } from '../src/memory/client.js'
import { pollUntil } from '../src/_utils/polling.js'

describe('MemoryClient Integration Tests', { timeout: 600_000, sequential: true }, () => {
  const region = process.env.AWS_REGION || 'us-west-2'
  const memoryName = `testmem_${Date.now()}`
  const actorId = 'test_actor'
  const sessionId = 'test_session'
  let client: MemoryClient
  let memoryId: string

  beforeAll(() => {
    client = new MemoryClient({ region })
  })

  afterAll(async () => {
    if (memoryId) {
      try {
        await client.deleteMemory({ memoryId })
        await pollUntil(
          async () => {
            try {
              await client.getMemory({ memoryId })
              return false
            } catch {
              return true
            }
          },
          { maxWaitSeconds: 120, pollIntervalMs: 5000 }
        )
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('creates a memory and waits for it to become active', async () => {
    const result = await client.createMemory({ name: memoryName, eventExpiryDuration: 3 })
    expect(result.memory?.id).toEqual(expect.any(String))
    memoryId = result.memory!.id!

    const became_active = await pollUntil(
      async () => {
        const resp = await client.getMemory({ memoryId })
        return resp.memory?.status === 'ACTIVE'
      },
      {
        maxWaitSeconds: 180,
        pollIntervalMs: 10_000,
        timeoutErrorMessage: `Memory ${memoryId} did not become ACTIVE within 180s`,
      }
    )
    expect(became_active).toBe(true)
  })

  it('retrieves the memory by id', async () => {
    const result = await client.getMemory({ memoryId })
    expect(result.memory).toMatchObject({ id: memoryId, status: 'ACTIVE' })
  })

  it('creates and retrieves events across a multi-turn conversation', async () => {
    await client.createEvent({
      memoryId,
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: 'USER', content: { text: 'hello' } } }],
    })

    await client.createEvent({
      memoryId,
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hi there' } } }],
    })

    const events = await client.listEvents({ memoryId, actorId, sessionId })
    expect(events.events?.length).toBe(2)
  })

  it('lists actors for the memory', async () => {
    const result = await client.listActors({ memoryId })
    expect(result.actorSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ actorId })]))
  })

  it('scoped memory works for data plane calls', async () => {
    const mem = client.memory(memoryId)
    const events = await mem.listEvents({ actorId, sessionId })
    expect(events.events?.length).toBe(2)
  })

  it('getLastKTurns retrieves conversation turns', async () => {
    const mem = client.memory(memoryId)
    const turns = await mem.getLastKTurns({ actorId, sessionId, k: 5 })
    expect(turns.length).toBeGreaterThan(0)
    const allMessages = turns.flat()
    expect(allMessages.length).toBeGreaterThan(0)
  })

  it('listBranches returns the default main branch', async () => {
    const mem = client.memory(memoryId)
    const branches = await mem.listBranches({ actorId, sessionId })
    expect(branches).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'main', eventCount: 2 })]))
  })

  it('deletes the memory', async () => {
    await client.deleteMemory({ memoryId })
    await pollUntil(
      async () => {
        try {
          await client.getMemory({ memoryId })
          return false
        } catch {
          return true
        }
      },
      {
        maxWaitSeconds: 120,
        pollIntervalMs: 5000,
        timeoutErrorMessage: `Memory ${memoryId} was not deleted within 120s`,
      }
    )

    await expect(client.getMemory({ memoryId })).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
    })
    memoryId = ''
  })
})
