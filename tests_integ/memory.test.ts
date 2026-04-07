/**
 * Integration tests for MemoryClient
 *
 * Requires:
 * - AWS credentials configured
 * - AgentCore Memory service available in the region
 * - Permissions for memory control plane and data plane operations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MemoryClient } from '../src/memory/client.js'

describe('MemoryClient Integration Tests', () => {
  const region = process.env.AWS_REGION || 'us-west-2'
  const memoryName = `test-memory-${Date.now()}`
  let client: MemoryClient
  let memoryId: string

  beforeAll(() => {
    client = new MemoryClient({ region })
  })

  afterAll(async () => {
    if (memoryId) {
      try {
        await client.deleteMemoryAndWait(memoryId, { maxWaitSeconds: 120, pollIntervalMs: 5000 })
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('creates a memory and waits for it to be active', async () => {
    const result = await client.createMemoryAndWait(
      { name: memoryName, eventExpiryDuration: 1 },
      { maxWaitSeconds: 120 }
    )

    memoryId = result.memory!.id!
    expect(memoryId).toBeDefined()
  })

  it('retrieves the memory by id', async () => {
    const result = await client.getMemory({ memoryId })
    expect(result.memory?.id).toBe(memoryId)
  })

  it('createOrGetMemory returns existing memory on conflict', async () => {
    const result = await client.createOrGetMemory({ name: memoryName, eventExpiryDuration: 1 })
    expect(result.memory?.id).toBe(memoryId)
  })

  it('creates and retrieves an event', async () => {
    await client.createEvent({
      memoryId,
      actorId: 'test-actor',
      sessionId: 'test-session',
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: 'USER', content: { text: 'hello' } } }],
    })

    const events = await client.listEvents({
      memoryId,
      actorId: 'test-actor',
      sessionId: 'test-session',
    })

    expect(events.events?.length).toBeGreaterThan(0)
  })

  it('lists actors for the memory', async () => {
    const result = await client.listActors({ memoryId })
    expect(result.actors).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: 'test-actor' })]))
  })

  it('scoped memory injects memoryId', async () => {
    const mem = client.memory(memoryId)
    const events = await mem.listEvents({ actorId: 'test-actor', sessionId: 'test-session' })
    expect(events.events?.length).toBeGreaterThan(0)
  })

  it('getLastKTurns retrieves conversation turns', async () => {
    const mem = client.memory(memoryId)
    const turns = await mem.getLastKTurns({ actorId: 'test-actor', sessionId: 'test-session', k: 5 })
    expect(turns.length).toBeGreaterThan(0)
    expect(turns[0]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'USER' })]))
  })

  it('deletes the memory and waits for completion', async () => {
    await client.deleteMemoryAndWait(memoryId, { maxWaitSeconds: 120, pollIntervalMs: 5000 })

    await expect(client.getMemory({ memoryId })).rejects.toMatchObject({ name: 'ResourceNotFoundException' })
    memoryId = '' // prevent afterAll double-delete
  })
})
