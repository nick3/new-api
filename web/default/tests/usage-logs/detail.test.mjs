import { describe, expect, test } from 'bun:test'
import {
  extractDetailMessages,
  extractDetailTools,
  extractStreamChunks,
  parsePayload,
} from '../../src/features/usage-logs/lib/detail.ts'

describe('usage log detail parsing', () => {
  test('extracts OpenAI-style request and response messages', () => {
    const request = parsePayload(
      JSON.stringify({
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Hello' },
        ],
      })
    )
    const response = parsePayload(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hi' } }],
      })
    )

    expect(extractDetailMessages(request, response).map((item) => item.content))
      .toEqual(['Be concise', 'Hello', 'Hi'])
  })

  test('extracts tool definitions and tool calls', () => {
    const request = parsePayload(
      JSON.stringify({
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object' } },
          },
        ],
      })
    )
    const response = parsePayload(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
              ],
            },
          },
        ],
      })
    )

    const tools = extractDetailTools(request, response)
    expect(tools.map((item) => item.kind)).toEqual([
      'Tool definition',
      'Tool call',
    ])
    expect(tools.map((item) => item.name)).toEqual(['lookup', 'lookup'])
  })

  test('extracts SSE chunks from non-truncated payloads', () => {
    const payload = parsePayload(
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
    )

    const chunks = extractStreamChunks(payload)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].role).toBe('assistant')
    expect(chunks[1].finishReason).toBe('stop')
  })

  test('does not parse stream chunks from truncated payloads', () => {
    const payload = parsePayload(
      'data: {"choices":[{"delta":{"content":"x"}}]}',
      10,
      10
    )

    expect(payload.isTruncated).toBe(true)
    expect(extractStreamChunks(payload)).toEqual([])
  })
})
