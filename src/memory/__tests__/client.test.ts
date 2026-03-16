import { describe, it, expect, vi } from 'vitest'
import { MemoryClient } from '../client.js'

function mockClient(methods: Record<string, (...args: unknown[]) => unknown>) {
  return new Proxy({}, {
    get: (_, prop) => methods[prop as string],
  })
}

function createClient() {
  const dpMethods: Record<string, ReturnType<typeof vi.fn>> = {}
  const cpMethods: Record<string, ReturnType<typeof vi.fn>> = {}

  const client = new MemoryClient({
    region: 'us-west-2',
    dataPlaneClient: mockClient(dpMethods) as any,
    controlPlaneClient: mockClient(cpMethods) as any,
  })

  return {
    client,
    stubDp(method: string, impl: (...args: unknown[]) => unknown) {
      dpMethods[method] = vi.fn(impl)
      return dpMethods[method]
    },
    stubCp(method: string, impl: (...args: unknown[]) => unknown) {
      cpMethods[method] = vi.fn(impl)
      return cpMethods[method]
    },
  }
}

describe('MemoryClient', () => {
  describe('constructor', () => {
    it('should initialize with provided region', () => {
      expect(new MemoryClient({ region: 'eu-west-1' })).toBeDefined()
    })

    it('should default to us-west-2 when no region provided', () => {
      const original = process.env.AWS_REGION
      delete process.env.AWS_REGION
      expect(new MemoryClient()).toBeDefined()
      process.env.AWS_REGION = original
    })
  })

  describe('passthrough', () => {
    it('should forward data plane methods with correct parameters', async () => {
      const { client, stubDp } = createClient()
      const spy = stubDp('createEvent', () => Promise.resolve({ event: { eventId: 'e1' } }))

      await client.createEvent({
        memoryId: 'mem-1', actorId: 'a1', sessionId: 's1',
        payload: [], eventTimestamp: new Date(),
      })

      expect(spy.mock.calls[0][0]).toMatchObject({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1' })
    })

    it('should forward control plane methods with correct parameters', async () => {
      const { client, stubCp } = createClient()
      const spy = stubCp('createMemory', () => Promise.resolve({ memory: { id: 'mem-1' } }))

      await client.createMemory({ name: 'test-mem', eventExpiryDuration: 30 })

      expect(spy.mock.calls[0][0]).toMatchObject({ name: 'test-mem', eventExpiryDuration: 30 })
    })
  })

  describe('memory()', () => {
    it('should inject memoryId into calls', async () => {
      const { client, stubDp } = createClient()
      const spy = stubDp('createEvent', () => Promise.resolve({ event: { eventId: 'e1' } }))

      await client.memory('mem-1').createEvent({ actorId: 'a1', sessionId: 's1', payload: [], eventTimestamp: new Date() })

      expect(spy.mock.calls[0][0]).toMatchObject({ memoryId: 'mem-1', actorId: 'a1', sessionId: 's1' })
    })

    it('should scope retrieveMemoryRecords with memoryId', async () => {
      const { client, stubDp } = createClient()
      const spy = stubDp('retrieveMemoryRecords', () => Promise.resolve({ memoryRecordSummaries: [] }))

      await client.memory('mem-1').retrieveMemoryRecords({
        namespace: '/facts/',
        searchCriteria: { searchQuery: 'test' },
      })

      expect(spy.mock.calls[0][0]).toMatchObject({ memoryId: 'mem-1', namespace: '/facts/' })
    })

    it('should paginate listAllEvents across pages', async () => {
      const { client, stubDp } = createClient()
      let callCount = 0
      stubDp('listEvents', () => {
        callCount++
        if (callCount === 1) return Promise.resolve({ events: [{ eventId: 'e1' }], nextToken: 'tok1' })
        return Promise.resolve({ events: [{ eventId: 'e2' }] })
      })

      const events = await client.memory('mem-1').listAllEvents({ actorId: 'a1', sessionId: 's1' })
      expect(events).toMatchObject([{ eventId: 'e1' }, { eventId: 'e2' }])
    })
  })

  describe('getLastKTurns()', () => {
    it('should return last K turns grouped by user messages at message level', async () => {
      const { client, stubDp } = createClient()
      stubDp('listEvents', () => Promise.resolve({
        events: [
          { eventId: 'e1', payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }] },
          { eventId: 'e2', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hello' } } }] },
          { eventId: 'e3', payload: [{ conversational: { role: 'USER', content: { text: 'bye' } } }] },
          { eventId: 'e4', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'goodbye' } } }] },
        ],
      }))

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 1 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('should finish processing current event before stopping at k', async () => {
      const { client, stubDp } = createClient()
      stubDp('listEvents', () => Promise.resolve({
        events: [
          { eventId: 'e1', payload: [
            { conversational: { role: 'USER', content: { text: 'a' } } },
            { conversational: { role: 'ASSISTANT', content: { text: 'b' } } },
          ]},
          { eventId: 'e2', payload: [
            { conversational: { role: 'USER', content: { text: 'c' } } },
            { conversational: { role: 'ASSISTANT', content: { text: 'd' } } },
          ]},
        ],
      }))

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 1 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('should return all available turns when k exceeds total', async () => {
      const { client, stubDp } = createClient()
      stubDp('listEvents', () => Promise.resolve({
        events: [
          { eventId: 'e1', payload: [{ conversational: { role: 'USER', content: { text: 'hi' } } }] },
          { eventId: 'e2', payload: [{ conversational: { role: 'ASSISTANT', content: { text: 'hello' } } }] },
        ],
      }))

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toMatchObject([[{ role: 'USER' }, { role: 'ASSISTANT' }]])
    })

    it('should return empty array for empty session', async () => {
      const { client, stubDp } = createClient()
      stubDp('listEvents', () => Promise.resolve({ events: [] }))

      const turns = await client.memory('mem-1').getLastKTurns({ actorId: 'a1', sessionId: 's1', k: 5 })
      expect(turns).toEqual([])
    })
  })

  describe('listBranches()', () => {
    it('should aggregate branch info from events', async () => {
      const { client, stubDp } = createClient()
      stubDp('listEvents', () => Promise.resolve({
        events: [
          { eventId: 'e1' },
          { eventId: 'e2' },
          { eventId: 'e3', branch: { name: 'alt', rootEventId: 'e1' } },
        ],
      }))

      const branches = await client.memory('mem-1').listBranches({ actorId: 'a1', sessionId: 's1' })
      expect(branches).toMatchObject([
        { name: 'main', eventCount: 2 },
        { name: 'alt', eventCount: 1, rootEventId: 'e1' },
      ])
    })
  })

  describe('createOrGetMemory()', () => {
    it('should return existing memory on ValidationException with already exists', async () => {
      const { client, stubCp } = createClient()
      stubCp('createMemory', () => {
        throw Object.assign(new Error('already exists'), { name: 'ValidationException' })
      })
      stubCp('getMemory', () => Promise.resolve({ memory: { id: 'mem-1' }, $metadata: {} }))

      const result = await client.createOrGetMemory({ name: 'test', eventExpiryDuration: 30 })
      expect(result).toMatchObject({ memory: { id: 'mem-1' } })
    })
  })

  describe('deleteMemoryAndWait()', () => {
    it('should resolve when ResourceNotFoundException is thrown', async () => {
      const { client, stubCp } = createClient()
      stubCp('deleteMemory', () => Promise.resolve({}))
      stubCp('getMemory', () => {
        throw Object.assign(new Error(), { name: 'ResourceNotFoundException' })
      })

      await expect(
        client.deleteMemoryAndWait('mem-1', { maxWaitSeconds: 5, pollIntervalMs: 10 }),
      ).resolves.toBeUndefined()
    })
  })
})
