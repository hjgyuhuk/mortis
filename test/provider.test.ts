import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../src/provider/openai.js'
import type { StreamChunk, Tool } from '../src/types.js'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers) server.close()
})

/** Collect every chunk of a stream into an array. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function openServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ url: string }> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve({ url: `http://127.0.0.1:${address.port}/v1` })
    })
  })
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
}

describe('OpenAIProvider', () => {
  it('posts to /chat/completions with translated messages and tools', async () => {
    const requests: unknown[] = []
    const { url } = await openServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
        res.setHeader('Content-Type', 'text/event-stream')
        res.end(sse([{ choices: [{ delta: { content: 'mock reply' } }] }]))
      })
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'test-model', apiKey: 'secret' })
    const tool: Tool = {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => '',
    }

    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], [tool]))

    expect(chunks).toEqual([{ kind: 'text', delta: 'mock reply' }])
    expect(requests).toHaveLength(1)
    const call = requests[0] as { url: string; headers: Record<string, string>; body: { model: string; messages: unknown[]; tools: unknown[]; stream: boolean } }
    expect(call.url).toBe('/v1/chat/completions')
    expect(call.headers.authorization).toBe('Bearer secret')
    expect(call.body.model).toBe('test-model')
    expect(call.body.stream).toBe(true)
    expect(call.body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(call.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ])
  })

  it('streams text deltas as they arrive', async () => {
    const { url } = await openServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end(sse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo ' } }] },
        { choices: [{ delta: { content: 'world' } }] },
        { choices: [{ delta: {} }] },
      ]))
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))

    expect(chunks).toEqual([
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo ' },
      { kind: 'text', delta: 'world' },
    ])
  })

  it('stitches incremental tool-call index fragments into complete calls', async () => {
    const { url } = await openServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'bash', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"com' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] },
        { choices: [{ delta: {} }] },
      ]))
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))

    expect(chunks).toEqual([
      {
        kind: 'tool_calls',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
    ])
  })

  it('ignores null id/name on later fragments while stitching', async () => {
    const { url } = await openServer((_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end(sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'bash', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"com' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: 'mand":"ls"}' } }] } }] },
        { choices: [{ delta: {} }] },
      ]))
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))

    expect(chunks).toEqual([
      {
        kind: 'tool_calls',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
    ])
  })

  it('handles a non-SSE JSON response as a single chunk', async () => {
    const { url } = await openServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'plain reply' } }] }))
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))

    expect(chunks).toEqual([{ kind: 'text', delta: 'plain reply' }])
  })

  it('translates a non-SSE tool_calls JSON response', async () => {
    const { url } = await openServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
              },
            },
          ],
        }),
      )
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))

    expect(chunks).toEqual([
      {
        kind: 'tool_calls',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
    ])
  })

  it('throws a readable error on non-200 responses', async () => {
    const { url } = await openServer((_req, res) => {
      res.statusCode = 401
      res.end('bad key')
    })

    const provider = new OpenAIProvider({ baseUrl: url, model: 'm' })
    await expect(collect(provider.completeStream([{ role: 'user', content: 'hi' }], []))).rejects.toThrow('provider request failed (401): bad key')
  })
})