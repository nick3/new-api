import type { UsageLog } from '../data/schema'

export const DETAIL_TRUNCATE_BYTES = 500 * 1024
export const DETAIL_PREVIEW_BYTES = 100 * 1024

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

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function contentText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return value
      .map((item) => contentText(item))
      .filter(Boolean)
      .join('\n')
  }

  if (!isRecord(value)) return stringifyValue(value)

  const type = stringValue(value.type)
  const directText = firstString(value.text, value.content, value.input, value.output)
  if (directText) return type ? `[${type}] ${directText}` : directText

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

  for (const item of asArray(value.input)) {
    if (!isRecord(item)) continue
    pushMessage(
      messages,
      source,
      stringValue(item.role) || stringValue(item.type) || 'user',
      item.content ?? item.text ?? item,
      stringValue(item.name)
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
      pushMessage(
        messages,
        source,
        stringValue(choice.message.role) || 'assistant',
        choice.message.content ?? choice.message.tool_calls ?? choice.message
      )
    }

    if (isRecord(choice.delta)) {
      pushMessage(
        messages,
        source,
        stringValue(choice.delta.role) || 'assistant',
        choice.delta.content ?? choice.delta.tool_calls ?? choice.delta
      )
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
    if (item.type !== 'message' && !item.role) continue
    pushMessage(
      messages,
      source,
      stringValue(item.role) || 'assistant',
      item.content ?? item.text ?? item
    )
  }
}

function appendMessagesFromPayload(
  messages: DetailMessage[],
  source: DetailPayloadSource,
  value: unknown
) {
  if (!isRecord(value)) return

  appendClaudeMessages(messages, source, value)
  appendOpenAiMessages(messages, source, value)
  appendInputMessages(messages, source, value)
  appendGeminiMessages(messages, source, value)
  appendChoiceMessages(messages, source, value)
  appendOutputMessages(messages, source, value)

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
  appendMessagesFromPayload(messages, 'response', responsePayload.json)
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
  if (payload.isTruncated) return []

  return splitSSE(payload.raw).map((event, index) => ({
    id: `stream-${index}`,
    index,
    raw: stringifyValue(event),
    ...describeStreamEvent(event),
  }))
}
