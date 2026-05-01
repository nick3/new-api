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
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function contentText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return decodeEscapedText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return value
      .map((item) => contentText(item))
      .filter(Boolean)
      .join('\n')
  }

  if (!isRecord(value)) return stringifyValue(value)

  const type = stringValue(value.type)
  const directText = firstString(
    value.text,
    value.content,
    value.input,
    value.output,
    value.value,
    value.data
  )
  if (directText) return type ? `[${type}] ${decodeEscapedText(directText)}` : decodeEscapedText(directText)

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

  if (typeof value.output_text === 'string' || typeof value.outputText === 'string') {
    pushMessage(messages, source, 'assistant', value.output_text ?? value.outputText)
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
  if (isRecord(value.function)) return stringValue(value.function.name) || 'Tool'
  if (isRecord(value.functionCall)) return stringValue(value.functionCall.name) || 'Tool'
  if (isRecord(value.functionResponse)) return stringValue(value.functionResponse.name) || 'Tool'
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
    pushToolEntry(entries, source, 'Tool choice', value.tool_choice, 'tool_choice')
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
      pushToolEntry(entries, source, 'Function call', choice.message.function_call)
    }
  }

  for (const block of asArray(value.content)) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') pushToolEntry(entries, source, 'Tool call', block)
    if (block.type === 'tool_result') pushToolEntry(entries, source, 'Tool result', block)
  }

  for (const item of asArray(value.output)) {
    if (!isRecord(item)) continue
    if (item.type === 'function_call') pushToolEntry(entries, source, 'Function call', item)
    if (item.type === 'function_call_output') {
      pushToolEntry(entries, source, 'Tool result', item)
    }
  }

  for (const candidate of asArray(value.candidates)) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue
    for (const part of asArray(candidate.content.parts)) {
      if (!isRecord(part)) continue
      if (part.functionCall) pushToolEntry(entries, source, 'Function call', part.functionCall)
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
  return Array.isArray(value.choices) && value.choices.some((choice) => isRecord(choice) && isRecord(choice.delta))
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
    const nested = payload.json.events ?? payload.json.data ?? payload.json.chunks
    if (Array.isArray(nested) && nested.some(looksLikeStreamObject)) {
      return limitStreamObjects(nested.filter(looksLikeStreamObject))
    }
  }

  if (!payload.json) return limitStreamObjects(splitSSE(payload.raw))
  return []
}

function appendStreamMessages(messages: DetailMessage[], payload: ParsedPayload) {
  const events = streamObjectsFromPayload(payload)
  if (events.length === 0) return

  if (events.some((event) => isRecord(event) && Array.isArray(event.choices))) {
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
        const existingFunction = isRecord(existing.function) ? existing.function : {}
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

    const parts = [reasoning && `[reasoning] ${reasoning}`, content]
      .filter(Boolean)
      .join('\n')
    const calls = Array.from(toolCalls.values())
    const messageContent = calls.length > 0 ? [parts, stringifyValue(calls)].filter(Boolean).join('\n') : parts
    pushMessage(messages, 'response', role, messageContent)
    return
  }

  let role = 'assistant'
  let content = ''
  let reasoning = ''
  const outputItems: unknown[] = []

  for (const event of events) {
    if (!isRecord(event)) continue
    role = stringValue(event.role) || (isRecord(event.message) ? stringValue(event.message.role) : undefined) || role

    const type = stringValue(event.type)
    if (type === 'content_block_start' && isRecord(event.content_block)) {
      outputItems.push(event.content_block)
      continue
    }
    if (type === 'content_block_delta' && isRecord(event.delta)) {
      content += stringValue(event.delta.text) || stringValue(event.delta.thinking) || stringValue(event.delta.partial_json) || ''
      continue
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      content += stringValue(event.delta) || stringValue(event.text) || stringValue(event.output_text) || ''
      continue
    }
    if (type?.includes('reasoning')) {
      reasoning += stringValue(event.delta) || stringValue(event.text) || stringValue(event.reasoning_text) || ''
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      outputItems.push(event.item ?? event.output_item ?? event.outputItem ?? event.output)
    }
    if (isRecord(event.response)) {
      appendMessagesFromPayload(messages, 'response', event.response)
    }
  }

  const parts = [reasoning && `[reasoning] ${reasoning}`, content, outputItems.length > 0 && contentText(outputItems)]
    .filter(Boolean)
    .join('\n')
  pushMessage(messages, 'response', role, parts)
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
      content: contentText(delta?.content ?? delta?.tool_calls ?? message?.content ?? value),
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
    finishReason: firstString(value.finish_reason, value.finishReason, value.stop_reason),
  }
}

export function parsePayload(
  raw: string | null | undefined,
  previewBytes = DETAIL_PREVIEW_BYTES,
  truncateAt = DETAIL_TRUNCATE_BYTES
): ParsedPayload {
  const value = raw ?? ''
  const isTruncated = value.length > truncateAt
  const preview = isTruncated ? truncateForPreview(value, previewBytes) : value

  if (isTruncated) {
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
      formatted: JSON.stringify(json, null, 2),
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

export function splitSSE(raw: string | null | undefined): unknown[] {
  if (!raw) return []

  return raw
    .split(/\n\n|\r\n\r\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => {
      try {
        return JSON.parse(data) as unknown
      } catch {
        return data
      }
    })
}

export function extractStreamChunks(payload: ParsedPayload): DetailStreamChunk[] {
  return streamObjectsFromPayload(payload).map((event, index) => ({
    id: `stream-${index}`,
    index,
    raw: stringifyValue(event),
    ...describeStreamEvent(event),
  }))
}
