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
import type { UsageLog } from '../data/schema'

export const DETAIL_TRUNCATE_BYTES = 500 * 1024
export const DETAIL_PREVIEW_BYTES = 100 * 1024
const DETAIL_STREAM_EVENT_LIMIT = 5000

type DetailPayloadSource = 'request' | 'response'
type JsonRecord = Record<string, unknown>

export interface ParsedPayload {
  raw: string
  preview: string
  formatted: string
  json: unknown | null
  isJson: boolean
  isTruncated: boolean
}

export interface DetailMessage {
  id: string
  source: DetailPayloadSource
  role: string
  content: string
  name?: string
}

export interface DetailToolEntry {
  id: string
  source: DetailPayloadSource
  kind: string
  name: string
  content: string
}

export interface DetailStreamChunk {
  id: string
  index: number
  event?: string
  role?: string
  content: string
  finishReason?: string
  raw: string
}

interface ParsePayloadOptions {
  parseJsonWhenTruncated?: boolean
}

export function hasSavedDetail(log: UsageLog): boolean {
  const requestBody = log.detail?.request_body?.trim() ?? ''
  const responseBody = log.detail?.response_body?.trim() ?? ''
  return requestBody.length > 0 || responseBody.length > 0
}

function truncateForPreview(raw: string, previewBytes: number): string {
  if (raw.length <= previewBytes) return raw
  return raw.slice(0, previewBytes)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string')
}

function decodeEscapedText(value: string): string {
  if (!/(\\u[0-9a-fA-F]{4})|(\\n)|(\\r)|(\\t)/.test(value)) return value
  return value
    .replaceAll(/\\u([0-9a-fA-F]{4})/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value, null, 2)
}

function toFormattedString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return stringifyValue(value)

  const trimmed = value.trim()
  if (!trimmed) return ''

  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2)
  } catch {
    return decodeEscapedText(trimmed)
  }
}

function formatToolCallContent(value: JsonRecord): string {
  const functionValue = isRecord(value.function) ? value.function : undefined
  const deltaValue = isRecord(value.delta) ? value.delta : undefined
  const name =
    firstString(
      value.name,
      functionValue?.name,
      value.tool_name,
      value.function_name
    ) || toolName(value)
  const argsSource =
    value.arguments ??
    value.input ??
    value.payload ??
    functionValue?.arguments ??
    value.parameters ??
    value.input_json ??
    deltaValue?.arguments ??
    deltaValue?.partial_json ??
    {}
  const label = value.type === 'tool_use' ? 'tool_use' : 'function_call'
  return [`[${label}] ${name}`, toFormattedString(argsSource)]
    .filter(Boolean)
    .join('\n')
}

function formatToolResultContent(value: JsonRecord): string {
  const valueSource =
    value.content ??
    value.result ??
    value.output ??
    value.text ??
    value.value ??
    value.data ??
    value.message ??
    value.body ??
    value
  const name =
    firstString(value.name, value.tool_name, value.toolName) || toolName(value)
  return [`[tool_result] ${name}`, toFormattedString(valueSource)]
    .filter(Boolean)
    .join('\n')
}

function contentText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return decodeEscapedText(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => contentText(item).trim())
      .filter(Boolean)
      .join('\n')
  }

  if (!isRecord(value)) return stringifyValue(value)

  const type = stringValue(value.type) || stringValue(value.kind)
  if (
    type === 'text' ||
    type === 'input_text' ||
    type === 'output_text' ||
    type === 'summary_text'
  ) {
    return contentText(
      value.text ??
        value.value ??
        value.data ??
        value.text_output ??
        value.output_text
    )
  }

  if (type === 'tool_use' || type === 'function_call') {
    return formatToolCallContent(value)
  }

  if (
    type === 'tool_result' ||
    type === 'function_call_output' ||
    value.role === 'tool'
  ) {
    return formatToolResultContent(value)
  }

  if (type === 'reasoning' || type === 'thinking' || value.thinking) {
    const reasoning = contentText(
      value.text ??
        value.reasoning ??
        value.thinking ??
        value.value ??
        value.summary ??
        value.content
    )
    return reasoning ? `[reasoning] ${reasoning}` : ''
  }

  const directText = firstString(
    value.text,
    value.content,
    value.input,
    value.output,
    value.value,
    value.data
  )
  if (directText) return decodeEscapedText(directText)

  if (isRecord(value.message)) return contentText(value.message)
  if (isRecord(value.delta)) return contentText(value.delta)
  if (isRecord(value.functionCall)) {
    return `[functionCall] ${stringifyValue(value.functionCall)}`
  }
  if (isRecord(value.functionResponse)) {
    return `[functionResponse] ${stringifyValue(value.functionResponse)}`
  }
  if (isRecord(value.image_url)) {
    return `[${type || 'image'}] ${stringifyValue(value.image_url)}`
  }
  if (value.source) {
    return `[${type || 'source'}] ${stringifyValue(value.source)}`
  }

  return stringifyValue(value)
}

function firstContentText(...values: unknown[]): string {
  for (const value of values) {
    const text = contentText(value)
    if (text.length > 0) return text
  }
  return ''
}

function pushMessage(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  role: string,
  content: unknown,
  name?: string
) {
  const text = contentText(content).trim()
  if (!text && !name) return

  messages.push({
    id: `${source}-${messages.length}`,
    source,
    role: role || (source === 'request' ? 'user' : 'assistant'),
    content: text || '-',
    name,
  })
}

function pushMessageFromRecord(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord,
  fallbackRole: string
) {
  const role = stringValue(value.role) || fallbackRole
  const content =
    value.content ??
    value.text ??
    value.message ??
    value.delta ??
    value.output ??
    value.tool_calls ??
    value.function_call ??
    value.result ??
    value
  pushMessage(messages, source, role, content, stringValue(value.name))
}

function appendOpenAiMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  for (const item of asArray(value.messages)) {
    if (!isRecord(item)) continue
    pushMessage(
      messages,
      source,
      stringValue(item.role) || 'user',
      item.content ?? item,
      stringValue(item.name)
    )
  }
}

function appendInputMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  if (typeof value.input === 'string') {
    pushMessage(messages, source, 'user', value.input)
    return
  }

  if (isRecord(value.input)) {
    pushMessageFromRecord(messages, source, value.input, 'user')
    return
  }

  for (const item of asArray(value.input)) {
    if (typeof item === 'string') {
      pushMessage(messages, source, 'user', item)
      continue
    }
    if (!isRecord(item)) continue
    pushMessageFromRecord(
      messages,
      source,
      item,
      stringValue(item.role) || stringValue(item.type) || 'user'
    )
  }
}

function appendGeminiMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  for (const item of asArray(value.contents)) {
    if (!isRecord(item)) continue
    pushMessage(
      messages,
      source,
      stringValue(item.role) || 'user',
      item.parts ?? item.content ?? item
    )
  }

  for (const candidate of asArray(value.candidates)) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue
    pushMessage(
      messages,
      source,
      stringValue(candidate.content.role) || 'assistant',
      candidate.content.parts ?? candidate.content
    )
  }
}

function appendChoiceMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  for (const choice of asArray(value.choices)) {
    if (!isRecord(choice)) continue

    if (isRecord(choice.message)) {
      pushMessageFromRecord(messages, source, choice.message, 'assistant')
    }

    if (isRecord(choice.delta)) {
      pushMessageFromRecord(messages, source, choice.delta, 'assistant')
    }

    if (choice.text) {
      pushMessage(messages, source, 'assistant', choice.text)
    }
  }
}

function appendClaudeMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  if (value.system) pushMessage(messages, source, 'system', value.system)
  if (source === 'response' && value.content) {
    pushMessage(
      messages,
      source,
      stringValue(value.role) || 'assistant',
      value.content
    )
  }
}

function appendOutputMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  for (const item of asArray(value.output)) {
    if (!isRecord(item)) continue
    pushMessageFromRecord(
      messages,
      source,
      item,
      stringValue(item.role) || stringValue(value.role) || 'assistant'
    )
  }
}

function appendArrayMessages(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: unknown
) {
  for (const item of asArray(value)) {
    if (!isRecord(item)) continue
    pushMessageFromRecord(
      messages,
      source,
      item,
      stringValue(item.role) || (source === 'request' ? 'user' : 'assistant')
    )
  }
}

function appendMessagesFromPayload(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: unknown
) {
  if (Array.isArray(value)) {
    appendArrayMessages(messages, source, value)
    return
  }
  if (!isRecord(value)) return

  appendClaudeMessages(messages, source, value)
  appendOpenAiMessages(messages, source, value)
  appendInputMessages(messages, source, value)
  appendGeminiMessages(messages, source, value)
  appendChoiceMessages(messages, source, value)
  appendOutputMessages(messages, source, value)

  if (
    typeof value.output_text === 'string' ||
    typeof value.outputText === 'string'
  ) {
    pushMessage(
      messages,
      source,
      'assistant',
      value.output_text ?? value.outputText
    )
  }
  if (isRecord(value.message)) {
    pushMessageFromRecord(messages, source, value.message, 'assistant')
  }
  if (isRecord(value.result)) {
    pushMessageFromRecord(messages, source, value.result, 'assistant')
  }
  if (typeof value.completion === 'string') {
    pushMessage(messages, source, 'assistant', value.completion)
  }
  if (typeof value.reply === 'string') {
    pushMessage(messages, source, 'assistant', value.reply)
  }
  if (typeof value.prompt === 'string') {
    pushMessage(messages, source, 'user', value.prompt)
  }
}

function toolName(value: unknown): string {
  if (!isRecord(value)) return 'Tool'
  if (isRecord(value.function)) {
    return stringValue(value.function.name) || 'Tool'
  }
  if (isRecord(value.functionCall)) {
    return stringValue(value.functionCall.name) || 'Tool'
  }
  if (isRecord(value.functionResponse)) {
    return stringValue(value.functionResponse.name) || 'Tool'
  }
  return firstString(value.name, value.type, value.id) || 'Tool'
}

function pushToolEntry(
  entries: DetailToolEntry[],
  source: DetailPayloadSource,
  kind: string,
  value: unknown,
  name = toolName(value)
) {
  const content = stringifyValue(value).trim()
  if (!content) return

  entries.push({
    id: `${source}-${entries.length}`,
    source,
    kind,
    name,
    content,
  })
}

function appendToolDefinitions(
  entries: DetailToolEntry[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  for (const tool of asArray(value.tools)) {
    if (isRecord(tool) && Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        pushToolEntry(entries, source, 'Tool definition', declaration)
      }
      continue
    }
    pushToolEntry(entries, source, 'Tool definition', tool)
  }

  for (const fn of asArray(value.functions)) {
    pushToolEntry(entries, source, 'Function definition', fn)
  }

  if (value.tool_choice) {
    pushToolEntry(
      entries,
      source,
      'Tool choice',
      value.tool_choice,
      'tool_choice'
    )
  }
}

function appendToolCalls(
  entries: DetailToolEntry[],
  source: DetailPayloadSource,
  value: JsonRecord
) {
  if (value.function_call) {
    pushToolEntry(entries, source, 'Function call', value.function_call)
  }

  for (const choice of asArray(value.choices)) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue

    for (const call of asArray(choice.message.tool_calls)) {
      pushToolEntry(entries, source, 'Tool call', call)
    }

    if (choice.message.function_call) {
      pushToolEntry(
        entries,
        source,
        'Function call',
        choice.message.function_call
      )
    }
  }

  for (const block of asArray(value.content)) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') {
      pushToolEntry(entries, source, 'Tool call', block)
    }
    if (block.type === 'tool_result') {
      pushToolEntry(entries, source, 'Tool result', block)
    }
  }

  for (const item of asArray(value.output)) {
    if (!isRecord(item)) continue
    if (item.type === 'function_call') {
      pushToolEntry(entries, source, 'Function call', item)
    }
    if (item.type === 'function_call_output') {
      pushToolEntry(entries, source, 'Tool result', item)
    }
  }

  for (const candidate of asArray(value.candidates)) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue
    for (const part of asArray(candidate.content.parts)) {
      if (!isRecord(part)) continue
      if (part.functionCall) {
        pushToolEntry(entries, source, 'Function call', part.functionCall)
      }
      if (part.functionResponse) {
        pushToolEntry(entries, source, 'Tool result', part.functionResponse)
      }
    }
  }
}

function appendToolsFromPayload(
  entries: DetailToolEntry[],
  source: DetailPayloadSource,
  value: unknown
) {
  if (!isRecord(value)) return
  appendToolDefinitions(entries, source, value)
  appendToolCalls(entries, source, value)
}

function looksLikeStreamObject(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.type === 'string') {
    return (
      value.type.startsWith('response.') ||
      value.type.startsWith('message_') ||
      value.type.startsWith('content_block_') ||
      value.type.startsWith('input_json_')
    )
  }
  if (value.object === 'chat.completion.chunk') return true
  return (
    Array.isArray(value.choices) &&
    value.choices.some((choice) => isRecord(choice) && isRecord(choice.delta))
  )
}

function limitStreamObjects(events: unknown[]): unknown[] {
  return events.slice(0, DETAIL_STREAM_EVENT_LIMIT)
}

function streamObjectsFromPayload(payload: ParsedPayload): unknown[] {
  if (payload.isTruncated) return []

  if (looksLikeStreamObject(payload.json)) return [payload.json]

  if (Array.isArray(payload.json)) {
    const direct = payload.json.filter(looksLikeStreamObject)
    if (direct.length > 0) return limitStreamObjects(direct)

    for (const item of payload.json) {
      if (!isRecord(item)) continue
      const nested = item.events ?? item.data ?? item.chunks
      if (Array.isArray(nested) && nested.some(looksLikeStreamObject)) {
        return limitStreamObjects(nested.filter(looksLikeStreamObject))
      }
    }
  }

  if (isRecord(payload.json)) {
    const nested =
      payload.json.events ?? payload.json.data ?? payload.json.chunks
    if (Array.isArray(nested) && nested.some(looksLikeStreamObject)) {
      return limitStreamObjects(nested.filter(looksLikeStreamObject))
    }
  }

  if (!payload.json) return limitStreamObjects(splitSSE(payload.raw))
  return []
}

function mergeFunctionCallArguments(
  item: unknown,
  fallbackOutputIndex: number,
  argumentsByKey: Map<string, string>
): unknown {
  if (!isRecord(item)) return item

  const outputIndex =
    item.output_index ?? item.outputIndex ?? fallbackOutputIndex
  const id = firstString(
    item.id,
    item.item_id,
    item.itemId,
    item.tool_call_id,
    item.toolCallId
  )
  const keys = [id, `output_index:${outputIndex}`].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  )
  const collected = keys
    .map((key) => argumentsByKey.get(key))
    .find((value) => typeof value === 'string' && value.length > 0)
  if (!collected) return item

  const functionValue = isRecord(item.function) ? item.function : undefined
  const existing = firstString(
    item.arguments,
    item.input_json,
    item.input,
    functionValue?.arguments,
    item.parameters
  )
  if (existing && existing.length >= collected.length) return item

  if (functionValue) {
    return {
      ...item,
      function: {
        ...functionValue,
        arguments: collected,
      },
    }
  }

  return { ...item, arguments: collected }
}

function getFunctionCallKeys(event: JsonRecord): string[] {
  const id = firstString(
    event.item_id,
    event.itemId,
    event.id,
    event.tool_call_id,
    event.toolCallId
  )
  const outputIndex = event.output_index ?? event.outputIndex ?? 0
  return [id, `output_index:${outputIndex}`].filter(
    (key): key is string => typeof key === 'string' && key.length > 0
  )
}

function appendFunctionCallArguments(
  argumentsByKey: Map<string, string>,
  event: JsonRecord,
  fragment: unknown
) {
  if (typeof fragment !== 'string') return
  for (const key of getFunctionCallKeys(event)) {
    argumentsByKey.set(key, `${argumentsByKey.get(key) || ''}${fragment}`)
  }
}

function aggregateOpenAiStreamMessages(events: unknown[]): JsonRecord | null {
  let role = 'assistant'
  let content = ''
  let reasoning = ''
  const toolCalls = new Map<number, JsonRecord>()

  for (const event of events) {
    if (!isRecord(event) || !Array.isArray(event.choices)) continue
    const choice = event.choices.find(isRecord)
    if (!choice || !isRecord(choice.delta)) continue
    const delta = choice.delta
    role = stringValue(delta.role) || role
    content += stringValue(delta.content) || ''
    reasoning += stringValue(delta.reasoning_content) || ''

    for (const [fallbackIndex, call] of asArray(delta.tool_calls).entries()) {
      if (!isRecord(call)) continue
      const index = typeof call.index === 'number' ? call.index : fallbackIndex
      const existing = toolCalls.get(index) ?? {}
      const existingFunction = isRecord(existing.function)
        ? existing.function
        : {}
      const nextFunction = isRecord(call.function) ? call.function : {}
      toolCalls.set(index, {
        ...existing,
        ...call,
        function: {
          ...existingFunction,
          ...nextFunction,
          arguments: `${stringValue(existingFunction.arguments) || ''}${stringValue(nextFunction.arguments) || ''}`,
        },
      })
    }
  }

  const message: JsonRecord = { role }
  if (content) message.content = content
  if (reasoning.trim()) message.reasoning = reasoning
  const calls = [...toolCalls.values()]
  if (calls.length > 0) message.tool_calls = calls
  return Object.keys(message).length > 1 ? message : null
}

function aggregateResponsesStreamMessages(
  events: unknown[]
): JsonRecord | null {
  const textByIndex = new Map<string, string>()
  const outputItemsByIndex = new Map<unknown, JsonRecord>()
  const argumentsByKey = new Map<string, string>()
  let reasoning = ''
  let latestResponse: JsonRecord | null = null

  const appendIndexedText = (
    outputIndex: unknown,
    contentIndex: unknown,
    fragment: unknown
  ) => {
    const text = contentText(fragment)
    if (!text) return
    const key = `${outputIndex ?? 0}:${contentIndex ?? 0}`
    textByIndex.set(key, `${textByIndex.get(key) || ''}${text}`)
  }

  const upsertOutputItem = (outputIndexRaw: unknown, item: unknown) => {
    if (!isRecord(item)) return
    const outputIndex =
      outputIndexRaw ??
      item.output_index ??
      item.outputIndex ??
      item.output_item_index ??
      item.outputItemIndex
    const indexKey = outputIndex ?? outputItemsByIndex.size
    const existing = outputItemsByIndex.get(indexKey)
    outputItemsByIndex.set(indexKey, {
      ...existing,
      ...item,
      ...(outputIndex !== undefined && outputIndex !== null
        ? { output_index: outputIndex }
        : {}),
    })
  }

  for (const event of events) {
    if (!isRecord(event)) continue
    if (isRecord(event.response)) latestResponse = event.response

    const type = stringValue(event.type)
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      upsertOutputItem(
        event.output_index ??
          event.outputIndex ??
          (isRecord(event.item)
            ? (event.item.output_index ?? event.item.outputIndex)
            : undefined),
        event.item ?? event.output_item ?? event.outputItem ?? event.output
      )
      continue
    }

    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.tool_call_arguments.delta'
    ) {
      appendFunctionCallArguments(
        argumentsByKey,
        event,
        event.delta ?? event.arguments_delta ?? event.argumentsDelta
      )
      continue
    }

    if (
      type === 'response.function_call_arguments.done' ||
      type === 'response.tool_call_arguments.done'
    ) {
      for (const key of getFunctionCallKeys(event)) {
        const full = stringValue(event.arguments) ?? stringValue(event.delta)
        if (full !== undefined) argumentsByKey.set(key, full)
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      appendIndexedText(
        event.output_index,
        event.content_index,
        event.delta ?? event.text ?? event.output_text
      )
      continue
    }

    if (type === 'response.output_text.done') {
      appendIndexedText(
        event.output_index,
        event.content_index,
        event.text ?? event.output_text ?? event.delta
      )
      continue
    }

    if (type?.includes('reasoning')) {
      reasoning += contentText(
        event.delta ?? event.text ?? event.reasoning_text
      )
    }
  }

  const mergedText = [...textByIndex.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, value]) => value)
    .join('')
  const responseOutput = Array.isArray(latestResponse?.output)
    ? latestResponse.output
    : []
  const outputFromResponse = responseOutput.length > 0
  const outputFromEvents = [...outputItemsByIndex.entries()]
    .sort((a, b) => {
      const left = Number(a[0])
      const right = Number(b[0])
      const safeLeft = Number.isFinite(left) ? left : 0
      const safeRight = Number.isFinite(right) ? right : 0
      return safeLeft - safeRight
    })
    .map(([, value]) => value)
  const baseOutput = outputFromResponse ? responseOutput : outputFromEvents
  const patchedOutput = baseOutput.map((item, index) =>
    mergeFunctionCallArguments(item, index, argumentsByKey)
  )
  const syntheticOutput =
    patchedOutput.length > 0
      ? []
      : [...argumentsByKey.entries()]
          .filter(
            ([key, value]) => key.startsWith('output_index:') && value.trim()
          )
          .map(([key, value]) => ({
            type: 'function_call',
            output_index: Number(key.slice('output_index:'.length)),
            name: 'function_call',
            arguments: value,
          }))
  const output = patchedOutput.length > 0 ? patchedOutput : syntheticOutput

  if (output.length > 0) {
    return {
      role: stringValue(latestResponse?.role) || 'assistant',
      output,
      ...(!outputFromResponse && mergedText.trim()
        ? { content: mergedText }
        : {}),
      ...(reasoning.trim() ? { reasoning } : {}),
    }
  }

  const fallbackText = contentText(
    latestResponse?.output_text ??
      latestResponse?.outputText ??
      latestResponse?.text ??
      latestResponse?.content ??
      latestResponse?.output_texts
  )
  if (fallbackText.trim()) {
    return {
      role: stringValue(latestResponse?.role) || 'assistant',
      content: fallbackText,
      ...(reasoning.trim() ? { reasoning } : {}),
    }
  }

  if (!mergedText.trim() && !reasoning.trim()) return null
  return {
    role: 'assistant',
    ...(mergedText.trim() ? { content: mergedText } : {}),
    ...(reasoning.trim() ? { reasoning } : {}),
  }
}

interface ClaudeStreamBlock extends JsonRecord {
  partialJson: string
  reasoning: string
  text: string
  input?: unknown
  content?: unknown
  id?: unknown
  name?: unknown
}

function aggregateClaudeStreamMessages(events: unknown[]): JsonRecord | null {
  const blocks = new Map<number, ClaudeStreamBlock>()
  let role = 'assistant'
  let reasoning = ''

  const getBlock = (index: number): ClaudeStreamBlock => {
    const existing = blocks.get(index)
    if (existing) return existing
    const block: ClaudeStreamBlock = {
      type: 'text',
      text: '',
      partialJson: '',
      reasoning: '',
    }
    blocks.set(index, block)
    return block
  }

  for (const event of events) {
    if (!isRecord(event)) continue
    const type = stringValue(event.type)

    if (type === 'message_start' && isRecord(event.message)) {
      role = stringValue(event.message.role) || role
      continue
    }

    if (type === 'content_block_start' && isRecord(event.content_block)) {
      const index = typeof event.index === 'number' ? event.index : blocks.size
      const block = getBlock(index)
      Object.assign(block, {
        type: event.content_block.type ?? block.type,
        text: stringValue(event.content_block.text) || '',
        name: event.content_block.name,
        id: event.content_block.id,
        input: event.content_block.input,
        content: event.content_block.content,
        reasoning: stringValue(event.content_block.thinking) || '',
      })
      continue
    }

    if (type === 'content_block_delta' && isRecord(event.delta)) {
      const index = typeof event.index === 'number' ? event.index : 0
      const block = getBlock(index)
      const deltaType = stringValue(event.delta.type)
      if (deltaType === 'text_delta' || event.delta.text) {
        block.text = `${block.text || ''}${stringValue(event.delta.text) || ''}`
      } else if (deltaType === 'thinking_delta') {
        block.reasoning = `${block.reasoning || ''}${stringValue(event.delta.thinking) || ''}`
      } else if (
        deltaType === 'input_json_delta' ||
        deltaType === 'tool_use_delta'
      ) {
        block.partialJson = `${block.partialJson || ''}${stringValue(event.delta.partial_json) || stringValue(event.delta.partialJson) || stringValue(event.delta.arguments) || ''}`
      }
      continue
    }

    if (type === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0
      const block = getBlock(index)
      if (block.partialJson?.trim()) {
        try {
          block.input = JSON.parse(block.partialJson) as unknown
        } catch {
          block.input = block.partialJson
        }
      }
      continue
    }

    if (type === 'message_delta' && isRecord(event.delta)) {
      role = stringValue(event.delta.role) || role
      reasoning += contentText(event.delta.reasoning)
    }
  }

  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => {
      if (block.reasoning) reasoning += block.reasoning
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input:
            block.input ??
            (block.partialJson?.trim() ? block.partialJson : undefined),
        }
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content: block.content ?? block.text ?? block.input,
        }
      }
      return {
        type: block.type || 'text',
        text: block.text || '',
        content: block.content,
      }
    })
    .filter((item) => contentText(item).trim())

  if (content.length === 0 && !reasoning.trim()) return null
  return {
    role,
    ...(content.length > 0 ? { content } : {}),
    ...(reasoning.trim() ? { reasoning } : {}),
  }
}

function appendStreamMessages(
  messages: DetailMessage[],
  payload: ParsedPayload
) {
  const events = streamObjectsFromPayload(payload)
  if (events.length === 0) return

  let aggregated: JsonRecord | null
  if (events.some((event) => isRecord(event) && Array.isArray(event.choices))) {
    aggregated = aggregateOpenAiStreamMessages(events)
  } else if (
    events.some(
      (event) =>
        isRecord(event) && stringValue(event.type)?.startsWith('response.')
    )
  ) {
    aggregated = aggregateResponsesStreamMessages(events)
  } else {
    aggregated = aggregateClaudeStreamMessages(events)
  }

  if (aggregated) {
    pushMessageFromRecord(messages, 'response', aggregated, 'assistant')
  }
}

function describeStreamEvent(value: unknown): {
  event?: string
  role?: string
  content: string
  finishReason?: string
} {
  if (!isRecord(value)) return { content: stringifyValue(value) }

  if (Array.isArray(value.choices) && isRecord(value.choices[0])) {
    const choice = value.choices[0]
    const delta = isRecord(choice.delta) ? choice.delta : undefined
    const message = isRecord(choice.message) ? choice.message : undefined
    return {
      event: stringValue(value.object) || stringValue(value.type),
      role: stringValue(delta?.role) || stringValue(message?.role),
      content: firstContentText(
        delta?.content,
        delta?.reasoning_content,
        delta?.reasoningContent,
        delta?.tool_calls,
        delta?.function_call,
        message?.content
      ),
      finishReason: stringValue(choice.finish_reason),
    }
  }

  if (value.type === 'content_block_delta' && isRecord(value.delta)) {
    return {
      event: stringValue(value.type),
      content: contentText(value.delta.text ?? value.delta),
    }
  }

  if (value.type === 'message_delta' && isRecord(value.delta)) {
    return {
      event: stringValue(value.type),
      content: contentText(value.delta),
      finishReason: stringValue(value.delta.stop_reason),
    }
  }

  if (Array.isArray(value.candidates) && isRecord(value.candidates[0])) {
    const candidate = value.candidates[0]
    const content = isRecord(candidate.content) ? candidate.content : undefined
    return {
      event: stringValue(value.type),
      role: stringValue(content?.role),
      content: contentText(content?.parts ?? candidate),
      finishReason: stringValue(candidate.finishReason),
    }
  }

  return {
    event: stringValue(value.type) || stringValue(value.event),
    role: stringValue(value.role),
    content: contentText(value.text ?? value.content ?? value.delta ?? value),
    finishReason: firstString(
      value.finish_reason,
      value.finishReason,
      value.stop_reason
    ),
  }
}

export function parsePayload(
  raw: string | null | undefined,
  previewBytes = DETAIL_PREVIEW_BYTES,
  truncateAt = DETAIL_TRUNCATE_BYTES,
  options: ParsePayloadOptions = {}
): ParsedPayload {
  const value = raw ?? ''
  const isTruncated = value.length > truncateAt
  const preview = isTruncated ? truncateForPreview(value, previewBytes) : value

  if (isTruncated && !options.parseJsonWhenTruncated) {
    return {
      raw: value,
      preview,
      formatted: preview,
      json: null,
      isJson: false,
      isTruncated,
    }
  }

  try {
    const json = JSON.parse(value) as unknown
    return {
      raw: value,
      preview,
      formatted: isTruncated ? preview : JSON.stringify(json, null, 2),
      json,
      isJson: true,
      isTruncated,
    }
  } catch {
    return {
      raw: value,
      preview,
      formatted: preview,
      json: null,
      isJson: false,
      isTruncated,
    }
  }
}

export function extractDetailMessages(
  requestPayload: ParsedPayload,
  responsePayload: ParsedPayload
): DetailMessage[] {
  const messages: DetailMessage[] = []
  appendMessagesFromPayload(messages, 'request', requestPayload.json)

  if (streamObjectsFromPayload(responsePayload).length > 0) {
    appendStreamMessages(messages, responsePayload)
  } else {
    appendMessagesFromPayload(messages, 'response', responsePayload.json)
  }

  return messages
}

export function extractDetailTools(
  requestPayload: ParsedPayload,
  responsePayload: ParsedPayload
): DetailToolEntry[] {
  const entries: DetailToolEntry[] = []
  appendToolsFromPayload(entries, 'request', requestPayload.json)
  appendToolsFromPayload(entries, 'response', responsePayload.json)
  return entries
}

function parseJsonCandidate(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function splitConcatenatedJsonObjects(value: string): unknown[] {
  const objects: unknown[] = []
  let buffer = ''
  let depth = 0
  let inString = false
  let escapeNext = false

  for (const char of value) {
    buffer += char

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\') {
      escapeNext = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') depth += 1
    if (char === '}') depth -= 1

    if (depth === 0 && buffer.trim()) {
      const parsed = parseJsonCandidate(buffer.trim())
      if (parsed) objects.push(parsed)
      buffer = ''
    }
  }

  return objects
}

export function splitSSE(raw: string | null | undefined): unknown[] {
  if (!raw) return []

  const trimmed = raw.trim()
  if (!trimmed) return []

  const objects: unknown[] = []
  const pushCandidate = (candidate: string) => {
    const data = candidate.trim()
    if (!data || data === '[DONE]') return
    const parsed = parseJsonCandidate(data)
    if (parsed) objects.push(parsed)
  }

  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const candidate = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    pushCandidate(candidate)
  }

  if (objects.length > 0) return objects

  let dataBuffer = ''
  const flushBuffer = () => {
    pushCandidate(dataBuffer)
    dataBuffer = ''
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const current = line.trim()
    if (!current) {
      flushBuffer()
      continue
    }
    if (!current.startsWith('data:')) continue

    const payload = current.slice(5).trim()
    if (!payload) continue
    if (!dataBuffer) {
      const parsed = parseJsonCandidate(payload)
      if (parsed) {
        objects.push(parsed)
        continue
      }
    }

    dataBuffer += payload
    const parsed = parseJsonCandidate(dataBuffer)
    if (parsed) {
      objects.push(parsed)
      dataBuffer = ''
    }
  }
  flushBuffer()

  if (objects.length > 0) return objects

  return splitConcatenatedJsonObjects(trimmed)
}

export function extractStreamChunks(
  payload: ParsedPayload
): DetailStreamChunk[] {
  return streamObjectsFromPayload(payload).map((event, index) => ({
    id: `stream-${index}`,
    index,
    raw: stringifyValue(event),
    ...describeStreamEvent(event),
  }))
}
