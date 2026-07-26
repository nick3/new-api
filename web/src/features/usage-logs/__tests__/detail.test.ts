/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { describe, expect, test } from 'bun:test'

import {
  extractDetailMessages,
  extractDetailTools,
  extractStreamChunks,
  parsePayload,
} from '../lib/detail'

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

    expect(
      extractDetailMessages(request, response).map((item) => item.content)
    ).toEqual(['Be concise', 'Hello', 'Hi'])
  })

  test('extracts Chat Completions request messages from truncated payloads', () => {
    const request = parsePayload(
      JSON.stringify({
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: `Hello ${'x'.repeat(80)}` },
        ],
      }),
      20,
      30,
      { parseJsonWhenTruncated: true }
    )
    const response = parsePayload('{}')

    expect(request.isTruncated).toBe(true)
    expect(
      extractDetailMessages(request, response).map((item) => item.role)
    ).toEqual(['system', 'user'])
  })

  test('extracts Responses API request input messages', () => {
    const request = parsePayload(
      JSON.stringify({
        input: [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: 'Follow policy' }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Search docs' }],
          },
        ],
      })
    )
    const response = parsePayload('{}')

    expect(
      extractDetailMessages(request, response).map((item) => item.content)
    ).toEqual(['Follow policy', 'Search docs'])
  })

  test('extracts Messages API system and user request messages', () => {
    const request = parsePayload(
      JSON.stringify({
        system: [{ type: 'text', text: 'You are helpful' }],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello Claude' }],
          },
        ],
      })
    )
    const response = parsePayload('{}')

    expect(
      extractDetailMessages(request, response).map((item) => item.content)
    ).toEqual(['You are helpful', 'Hello Claude'])
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

  test('aggregates SSE chunks into response messages', () => {
    const request = parsePayload(
      JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] })
    )
    const response = parsePayload(
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.map((item) => item.content)).toEqual(['Hi', 'Hello'])
  })

  test('extracts reasoning stream chunk content without duplicating raw JSON', () => {
    const payload = parsePayload(
      'data: {"choices":[{"delta":{"content":null,"reasoning_content":"The","role":"assistant"},"finish_reason":null}]}\n\n'
    )

    const chunks = extractStreamChunks(payload)
    expect(chunks[0].content).toBe('The')
    expect(chunks[0].raw).toContain('reasoning_content')
    expect(chunks[0].content).not.toBe(chunks[0].raw)
  })

  test('extracts common response message fields', () => {
    const request = parsePayload(JSON.stringify({ prompt: 'Tell me a joke' }))
    const response = parsePayload(JSON.stringify({ output_text: 'Sure.' }))

    const messages = extractDetailMessages(request, response)
    expect(messages.map((item) => item.content)).toEqual([
      'Tell me a joke',
      'Sure.',
    ])
  })

  test('aggregates Claude-style stream events into response messages', () => {
    const request = parsePayload(JSON.stringify({ messages: [] }))
    const response = parsePayload(
      JSON.stringify([
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'content_block_delta', delta: { text: 'Hel' } },
        { type: 'content_block_delta', delta: { text: 'lo' } },
      ])
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.map((item) => item.content)).toEqual(['Hello'])
  })

  test('aggregates Responses API stream events into response messages', () => {
    const request = parsePayload(JSON.stringify({ input: 'Hi' }))
    const response = parsePayload(
      JSON.stringify({
        events: [
          { type: 'response.output_text.delta', delta: 'He' },
          { type: 'response.output_text.delta', delta: 'llo' },
        ],
      })
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.map((item) => item.content)).toEqual(['Hi', 'Hello'])
  })

  test('aggregates Responses API function call argument stream events', () => {
    const request = parsePayload(JSON.stringify({ input: 'Search' }))
    const response = parsePayload(
      JSON.stringify({
        events: [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', name: 'lookup' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '{"q"',
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: ':"x"}',
          },
        ],
      })
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.at(-1)?.content).toContain('[function_call] lookup')
    expect(messages.at(-1)?.content).toContain('"q": "x"')
  })

  test('uses Responses API function call argument done event as full value', () => {
    const request = parsePayload(JSON.stringify({ input: 'Search' }))
    const response = parsePayload(
      JSON.stringify({
        events: [
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'fc_1', type: 'function_call', name: 'lookup' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '{"partial":true}',
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_1',
            output_index: 0,
            arguments: '{"q":"final"}',
          },
        ],
      })
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.at(-1)?.content).toContain('"q": "final"')
    expect(messages.at(-1)?.content).not.toContain('partial')
  })

  test('aggregates Claude tool use JSON stream events', () => {
    const request = parsePayload(JSON.stringify({ messages: [] }))
    const response = parsePayload(
      JSON.stringify([
        { type: 'message_start', message: { role: 'assistant' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q"' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ':"x"}' },
        },
        { type: 'content_block_stop', index: 0 },
      ])
    )

    const messages = extractDetailMessages(request, response)
    expect(messages.at(-1)?.content).toContain('[tool_use] lookup')
    expect(messages.at(-1)?.content).toContain('"q": "x"')
  })

  test('parses SSE chunks without blank line separators', () => {
    const response = parsePayload(
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n' +
        'data: [DONE]\n'
    )

    const messages = extractDetailMessages(parsePayload('{}'), response)
    expect(messages.map((item) => item.content)).toEqual(['Hello'])
  })

  test('parses concatenated JSON stream objects', () => {
    const response = parsePayload(
      '{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}' +
        '{"choices":[{"delta":{"content":"lo"}}]}'
    )

    const messages = extractDetailMessages(parsePayload('{}'), response)
    expect(messages.map((item) => item.content)).toEqual(['Hello'])
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
