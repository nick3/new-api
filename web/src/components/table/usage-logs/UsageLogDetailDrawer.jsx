/*
Copyright (C) 2025 QuantumNous

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

import React, {
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
} from 'react';
import { useDebounce } from 'use-debounce';
import {
  SideSheet,
  Typography,
  Space,
  Descriptions,
  Divider,
  RadioGroup,
  Radio,
  Tag,
  Button,
  Input,
  Switch,
  Select,
  Dropdown,
  Tooltip,
  Toast,
  Tabs,
  Collapse,
} from '@douyinfe/semi-ui';
import {
  IconClose,
  IconCopy,
  IconSearch,
  IconFilter,
  IconChevronUp,
  IconChevronDown,
} from '@douyinfe/semi-icons';
import { copy } from '../../../helpers/utils';
import { useIsMobile } from '../../../hooks/common/useIsMobile';
import {
  safeParseJson,
  decodeUnicodeEscapes,
  formatJsonString,
} from './detail/logDetailPrimitives';

const { Title, Text, Paragraph } = Typography;

const normalizeSearchQuery = (raw) =>
  typeof raw === 'string' ? raw.trim().toLowerCase() : '';

const includesSearch = (value, queryLower) => {
  if (!queryLower) {
    return true;
  }
  if (value === undefined || value === null) {
    return false;
  }
  return String(value).toLowerCase().includes(queryLower);
};

const renderHighlightedText = (text, query) => {
  const raw = String(text ?? '');
  const q = normalizeSearchQuery(query);
  if (!q) {
    return raw;
  }
  const lower = raw.toLowerCase();
  const parts = [];
  let start = 0;
  let matchIndex = 0;
  while (true) {
    const idx = lower.indexOf(q, start);
    if (idx === -1) {
      break;
    }
    if (idx > start) {
      parts.push(raw.slice(start, idx));
    }
    const matched = raw.slice(idx, idx + q.length);
    parts.push(
      <mark
        key={`hit-${matchIndex}`}
        style={{
          background: 'var(--semi-color-primary-light-default)',
          borderRadius: 4,
          padding: '0 2px',
        }}
      >
        {matched}
      </mark>,
    );
    matchIndex += 1;
    start = idx + q.length;
  }
  if (start < raw.length) {
    parts.push(raw.slice(start));
  }
  return parts.length > 0 ? <>{parts}</> : raw;
};

const makeSegmentUid = (source, messageIndex, segmentIndex) => {
  const prefix = source === 'response' ? 'resp' : 'req';
  return `${prefix}-m${messageIndex}-s${segmentIndex}`;
};

const parseSegmentUid = (segmentUid) => {
  const match = /^(req|resp)-m(\d+)-s(\d+)$/.exec(String(segmentUid || ''));
  if (!match) {
    return null;
  }
  const source = match[1] === 'resp' ? 'response' : 'request';
  return {
    source,
    messageIndex: Number(match[2] || 0),
    segmentIndex: Number(match[3] || 0),
  };
};

const splitStreamingResponse = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const sseObjects = [];
  const segments = trimmed.split(/\r?\n\r?\n/);
  segments.forEach((segment) => {
    if (!segment) {
      return;
    }
    const dataLines = segment
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));
    if (dataLines.length === 0) {
      return;
    }
    const candidate = dataLines.map((line) => line.slice(5).trim()).join('');
    if (!candidate || candidate === '[DONE]') {
      return;
    }
    const parsed = safeParseJson(candidate);
    if (parsed) {
      sseObjects.push(parsed);
    }
  });

  if (sseObjects.length === 0) {
    // Fallback: tolerate SSE logs that contain `data:` lines but are not separated by blank lines.
    const lines = trimmed.split(/\r?\n/);
    let dataBuffer = '';
    const flushBuffer = () => {
      const candidate = dataBuffer.trim();
      dataBuffer = '';
      if (!candidate || candidate === '[DONE]') {
        return;
      }
      const parsed = safeParseJson(candidate);
      if (parsed) {
        sseObjects.push(parsed);
      }
    };

    lines.forEach((line) => {
      const current = typeof line === 'string' ? line.trim() : '';
      if (!current) {
        flushBuffer();
        return;
      }
      if (!current.startsWith('data:')) {
        return;
      }
      const payload = current.slice(5).trim();
      if (!payload) {
        return;
      }
      if (!dataBuffer) {
        const parsed = safeParseJson(payload);
        if (parsed) {
          sseObjects.push(parsed);
          return;
        }
        dataBuffer = payload;
        return;
      }

      dataBuffer += payload;
      const parsed = safeParseJson(dataBuffer);
      if (parsed) {
        sseObjects.push(parsed);
        dataBuffer = '';
      }
    });
    flushBuffer();
  }

  if (sseObjects.length > 0) {
    // For OpenAI-style streaming responses, return the original array
    // This will be processed by aggregateOpenAIStreamChunks later
    return sseObjects;
  }

  const objects = [];
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    buffer += char;

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }

    if (depth === 0 && buffer.trim()) {
      const parsed = safeParseJson(buffer);
      if (parsed) {
        objects.push(parsed);
      }
      buffer = '';
    }
  }

  return objects;
};

const looksLikeStreamObject = (obj) => {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  if (typeof obj.type === 'string') {
    if (obj.type.startsWith('response.')) {
      return true;
    }
    if (
      obj.type.startsWith('message_') ||
      obj.type.startsWith('content_block_') ||
      obj.type.startsWith('input_json_')
    ) {
      return true;
    }
  }
  if (obj.object === 'chat.completion.chunk') {
    return true;
  }
  if (Array.isArray(obj.choices) && obj.choices.some((c) => c?.delta)) {
    return true;
  }
  return false;
};

const normaliseContent = (content) => {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return decodeUnicodeEscapes(content);
  }
  if (Array.isArray(content)) {
    const combined = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item?.text) {
          return item.text;
        }
        if (item?.type === 'output_text' && item?.text_output) {
          return item.text_output;
        }
        return JSON.stringify(item);
      })
      .join('');
    return decodeUnicodeEscapes(combined);
  }
  if (typeof content === 'object') {
    if (content.text) {
      return decodeUnicodeEscapes(content.text);
    }
    if (content.value) {
      return decodeUnicodeEscapes(content.value);
    }
    if (content.content) {
      return normaliseContent(content.content);
    }
    return decodeUnicodeEscapes(JSON.stringify(content));
  }
  return decodeUnicodeEscapes(String(content));
};

const toFormattedString = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const parsed = safeParseJson(trimmed);
    if (parsed && typeof parsed === 'object') {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch (error) {
        return decodeUnicodeEscapes(trimmed);
      }
    }
    return decodeUnicodeEscapes(trimmed);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return decodeUnicodeEscapes(String(value));
  }
};

const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
};

const createSegment = (segment) => {
  if (!segment) {
    return null;
  }
  if (typeof segment.value === 'string' && segment.value.trim() === '') {
    return null;
  }
  return segment;
};

const createTextSegment = (value) => {
  const text = normaliseContent(value);
  if (!text || text.trim() === '') {
    return null;
  }
  return { type: 'text', value: text };
};

const createReasoningSegment = (value) => {
  const text = normaliseContent(value);
  if (!text || text.trim() === '') {
    return null;
  }
  return { type: 'reasoning', value: text };
};

const createToolCallSegment = (tool) => {
  if (!tool) {
    return null;
  }
  const name =
    tool.name ||
    tool.function?.name ||
    tool.tool_name ||
    tool.function_name ||
    tool.type ||
    'tool';
  const argsSource =
    tool.arguments ??
    tool.input ??
    tool.payload ??
    tool.function?.arguments ??
    tool.parameters ??
    tool.input_json ??
    tool.delta?.arguments ??
    tool.delta?.partial_json;
  const formatted = toFormattedString(argsSource ?? '');
  return createSegment({
    type: 'tool_call',
    id: tool.id || tool.tool_call_id || tool.toolUseId || tool.tool_use_id,
    name,
    value: formatted || '{}',
  });
};

const createToolResultSegment = (result) => {
  if (!result) {
    return null;
  }
  const valueSource =
    result.content ??
    result.result ??
    result.output ??
    result.text ??
    result.value ??
    result.data ??
    result.message ??
    result.body;
  const formatted = toFormattedString(
    valueSource !== undefined ? valueSource : result,
  );
  if (!formatted) {
    return null;
  }
  return {
    type: 'tool_result',
    id:
      result.tool_use_id ||
      result.toolUseId ||
      result.id ||
      result.tool_call_id,
    name: result.name || result.tool_name || result.toolName || 'tool',
    value: formatted,
  };
};

const createJsonSegment = (label, value) => {
  const formatted = toFormattedString(value);
  if (!formatted) {
    return null;
  }
  return { type: 'json', label, value: formatted };
};

const segmentsToPlainText = (segments) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return '';
  }
  return segments
    .filter(
      (segment) => segment.type === 'text' || segment.type === 'reasoning',
    )
    .map((segment) => segment.value)
    .join('\n');
};

const copyToClipboard = async (text) => {
  if (!text || !text.trim()) {
    return false;
  }

  return copy(text);
};

const getSegmentCopyText = (segment, t) => {
  if (!segment) {
    return '';
  }

  const value =
    typeof segment.value === 'string'
      ? segment.value
      : String(segment.value ?? '');

  switch (segment.type) {
    case 'reasoning':
      return `${t('思考过程')}:\n${value}`.trim();
    case 'tool_call': {
      const parts = [t('工具调用')];
      if (segment.name) {
        parts.push(`(${segment.name})`);
      }
      if (segment.id) {
        parts.push(`${t('ID')}: ${segment.id}`);
      }
      return `${parts.join(' ')}\n${value}`.trim();
    }
    case 'tool_result': {
      const parts = [t('工具结果')];
      if (segment.name) {
        parts.push(`(${segment.name})`);
      }
      if (segment.id) {
        parts.push(`${t('ID')}: ${segment.id}`);
      }
      return `${parts.join(' ')}\n${value}`.trim();
    }
    case 'json': {
      const label = segment.label ? t(segment.label) : '';
      return label ? `${label}:\n${value}`.trim() : value;
    }
    default:
      return value;
  }
};

const buildMessageCopyText = (message, t) => {
  if (!message) {
    return '';
  }

  const segments = Array.isArray(message.segments)
    ? message.segments.filter(Boolean)
    : [];

  if (segments.length === 0) {
    return (message.text ?? '').trim();
  }

  return segments
    .map((segment) => getSegmentCopyText(segment, t))
    .filter((text) => text && text.trim())
    .join('\n\n');
};

const buildMessageCopyTextByFormat = (message, t, format) => {
  if (!message) {
    return '';
  }

  const fmt = typeof format === 'string' ? format : 'full';

  if (fmt === 'full') {
    return buildMessageCopyText(message, t);
  }

  const segments = Array.isArray(message.segments)
    ? message.segments.filter(Boolean)
    : [];

  if (fmt === 'plain') {
    if (segments.length > 0) {
      return segmentsToPlainText(segments).trim();
    }
    return (message.text ?? '').trim();
  }

  if (fmt === 'tools') {
    if (segments.length === 0) {
      return '';
    }
    return segments
      .filter(
        (segment) => segment?.type === 'tool_call' || segment?.type === 'tool_result',
      )
      .map((segment) => getSegmentCopyText(segment, t))
      .filter((text) => text && text.trim())
      .join('\n\n');
  }

  if (fmt === 'markdown') {
    const lines = [];
    if (message.role) {
      lines.push(`**Role:** ${message.role}`);
    }
    if (segments.length === 0) {
      const text = (message.text ?? '').trim();
      if (text) {
        lines.push(text);
      }
      return lines.join('\n\n').trim();
    }

    segments.forEach((segment) => {
      if (!segment) {
        return;
      }
      const copyText = getSegmentCopyText(segment, t).trim();
      if (!copyText) {
        return;
      }
      if (
        segment.type === 'tool_call' ||
        segment.type === 'tool_result' ||
        segment.type === 'json'
      ) {
        lines.push(`\n\n\`\`\`\n${copyText}\n\`\`\``);
        return;
      }
      lines.push(copyText);
    });

    return lines
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return buildMessageCopyText(message, t);
};

const appendSegment = (segments, segment) => {
  const built = createSegment(segment);
  if (built) {
    segments.push(built);
  }
};

const addTextSegment = (segments, value) => {
  appendSegment(segments, createTextSegment(value));
};

const addReasoningSegment = (segments, value) => {
  appendSegment(segments, createReasoningSegment(value));
};

const addToolCallSegment = (segments, tool) => {
  appendSegment(segments, createToolCallSegment(tool));
};

const addToolResultSegment = (segments, result) => {
  appendSegment(segments, createToolResultSegment(result));
};

const addJsonSegment = (segments, label, value) => {
  appendSegment(segments, createJsonSegment(label, value));
};

const handleContentNode = (node, segments) => {
  if (node === undefined || node === null) {
    return;
  }
  if (
    typeof node === 'string' ||
    typeof node === 'number' ||
    typeof node === 'boolean'
  ) {
    addTextSegment(segments, String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => handleContentNode(child, segments));
    return;
  }

  const type = node.type || node.kind;

  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    addTextSegment(segments, node.text ?? node.value ?? node.data ?? '');
    return;
  }

  if (type === 'tool_use' || type === 'function_call') {
    addToolCallSegment(segments, node);
    return;
  }

  if (type === 'tool_result' || node.role === 'tool') {
    addToolResultSegment(segments, node);
    return;
  }

  if (type === 'reasoning' || type === 'thinking' || node.thinking) {
    addReasoningSegment(
      segments,
      node.text ?? node.reasoning ?? node.thinking ?? node.value,
    );
    return;
  }

  if (node.message) {
    handleContentNode(node.message, segments);
    return;
  }

  if (node.content) {
    handleContentNode(node.content, segments);
    return;
  }

  if (node.text) {
    addTextSegment(segments, node.text);
    return;
  }

  if (node.value) {
    addTextSegment(segments, node.value);
    return;
  }

  addJsonSegment(segments, type || 'data', node);
};

const buildMessageSegments = (source) => {
  const segments = [];

  if (!source) {
    return segments;
  }

  if (source.reasoning || source.reasoning_content) {
    addReasoningSegment(segments, source.reasoning ?? source.reasoning_content);
  }

  if (source.thinking) {
    addReasoningSegment(segments, source.thinking);
  }

  if (source.message) {
    handleContentNode(source.message, segments);
  }

  if (source.delta && (source.delta.text || source.delta.content)) {
    handleContentNode(source.delta.text ?? source.delta.content, segments);
  }

  if (source.content !== undefined) {
    handleContentNode(source.content, segments);
  } else if (source.text !== undefined) {
    addTextSegment(segments, source.text);
  }

  if (source.tool_calls) {
    ensureArray(source.tool_calls).forEach((tool) => {
      addToolCallSegment(segments, tool);
    });
  }

  if (source.function_call) {
    addToolCallSegment(segments, {
      id: source.function_call.id,
      name: source.function_call.name,
      arguments: source.function_call.arguments,
    });
  }

  if (source.tool_call) {
    addToolCallSegment(segments, source.tool_call);
  }

  if (source.tool_results) {
    ensureArray(source.tool_results).forEach((result) => {
      addToolResultSegment(segments, result);
    });
  }

  if (source.result) {
    addToolResultSegment(segments, source.result);
  }

  if (source.output) {
    handleContentNode(source.output, segments);
  }

  return segments;
};

const buildMessageFromSource = (source, fallbackRole = 'assistant') => {
  const role = source?.role || fallbackRole;
  const segments = buildMessageSegments(source);
  const text = segmentsToPlainText(segments);
  return {
    role,
    segments,
    text,
  };
};

const aggregateOpenAIStreamChunks = (streamObjects) => {
  if (!Array.isArray(streamObjects) || streamObjects.length === 0) {
    return null;
  }

  let role = 'assistant';
  let reasoningBuffer = '';
  let fullContent = '';
  const toolCalls = [];

  streamObjects.forEach((chunk) => {
    const choices = ensureArray(chunk?.choices);
    const choice = choices[0];
    if (!choice || !choice.delta) {
      return;
    }
    const delta = choice.delta;
    if (delta.role) {
      role = delta.role;
    }
    if (delta.content !== undefined && delta.content !== null) {
      // Concatenate the content fragments instead of pushing them to an array
      fullContent += delta.content;
    }
    if (delta.reasoning_content) {
      reasoningBuffer += normaliseContent(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolDelta, index) => {
        const targetIndex = toolDelta.index ?? index;
        const existing = toolCalls[targetIndex] || {
          id: toolDelta.id,
          type: toolDelta.type,
          function: {
            name: toolDelta.function?.name || '',
            arguments: '',
          },
        };
        if (toolDelta.id) {
          existing.id = toolDelta.id;
        }
        if (toolDelta.type) {
          existing.type = toolDelta.type;
        }
        if (toolDelta.function?.name) {
          existing.function = existing.function || {};
          existing.function.name = toolDelta.function.name;
        }
        if (toolDelta.function?.arguments) {
          existing.function = existing.function || {};
          existing.function.arguments =
            (existing.function.arguments || '') + toolDelta.function.arguments;
        }
        toolCalls[targetIndex] = existing;
      });
    }
  });

  const message = { role };

  // Set the full concatenated content as a single string
  if (fullContent) {
    message.content = fullContent;
  }

  if (reasoningBuffer.trim()) {
    message.reasoning = reasoningBuffer;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((call) => {
      if (call.function && call.function.arguments) {
        call.function.arguments = call.function.arguments;
      }
      return call;
    });
  }

  return message;
};

const aggregateResponsesStreamEvents = (events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return null;
  }

  const textByIndex = new Map();
  const outputItemsByIndex = new Map();
  const functionCallArgsByKey = new Map();
  let reasoning = '';
  let latestResponse = null;

  const appendIndexedText = (outputIndex, contentIndex, fragment) => {
    const text = normaliseContent(fragment);
    if (!text) {
      return;
    }
    const key = `${outputIndex ?? 0}:${contentIndex ?? 0}`;
    textByIndex.set(key, (textByIndex.get(key) || '') + text);
  };

  const getFunctionCallKeys = (event) => {
    if (!event || typeof event !== 'object') {
      return ['output_index:0'];
    }
    const keys = [];
    const id =
      event.item_id ??
      event.itemId ??
      event.id ??
      event.tool_call_id ??
      event.toolCallId;
    if (id !== undefined && id !== null && String(id).trim()) {
      keys.push(String(id));
    }
    const outputIndex = event.output_index ?? event.outputIndex;
    keys.push(`output_index:${outputIndex ?? 0}`);
    return Array.from(new Set(keys));
  };

  const appendFunctionCallArgs = (key, fragment) => {
    if (!key || typeof fragment !== 'string') {
      return;
    }
    functionCallArgsByKey.set(
      key,
      (functionCallArgsByKey.get(key) || '') + fragment,
    );
  };

  const upsertOutputItem = (outputIndexRaw, item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const outputIndex =
      outputIndexRaw ??
      item.output_index ??
      item.outputIndex ??
      item.output_item_index ??
      item.outputItemIndex;
    const indexKey = outputIndex ?? outputItemsByIndex.size;
    const existing = outputItemsByIndex.get(indexKey);
    const merged = existing ? { ...existing, ...item } : { ...item };
    if (outputIndex !== undefined && outputIndex !== null) {
      merged.output_index = outputIndex;
    }
    outputItemsByIndex.set(indexKey, merged);
  };

  const pickLongerString = (a, b) => {
    const left = typeof a === 'string' ? a : '';
    const right = typeof b === 'string' ? b : '';
    return right.length > left.length ? right : left;
  };

  const patchFunctionCallArguments = (item, fallbackOutputIndex) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const outputIndex =
      item.output_index ?? item.outputIndex ?? fallbackOutputIndex ?? 0;
    const id =
      item.id ??
      item.item_id ??
      item.itemId ??
      item.tool_call_id ??
      item.toolCallId;

    const keys = [];
    if (id !== undefined && id !== null) {
      keys.push(String(id));
    }
    keys.push(`output_index:${outputIndex}`);

    const collected = keys
      .map((key) => functionCallArgsByKey.get(key))
      .find((value) => typeof value === 'string' && value.length > 0);
    if (!collected) {
      return item;
    }

    const existingArgs =
      item.arguments ??
      item.input_json ??
      item.input ??
      item.function?.arguments ??
      item.parameters;
    const best = pickLongerString(existingArgs, collected);

    if (best === existingArgs) {
      return item;
    }

    if (item.function && typeof item.function === 'object') {
      return {
        ...item,
        function: {
          ...item.function,
          arguments: best,
        },
      };
    }

    return {
      ...item,
      arguments: best,
    };
  };

  events.forEach((event) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    const type = event.type;
    if (typeof type !== 'string') {
      return;
    }

    if (event.response && typeof event.response === 'object') {
      latestResponse = event.response;
    }

    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      const outputIndex =
        event.output_index ??
        event.outputIndex ??
        event.item?.output_index ??
        event.item?.outputIndex;
      const item =
        event.item ?? event.output_item ?? event.outputItem ?? event.output;
      upsertOutputItem(outputIndex, item);
    }

    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.tool_call_arguments.delta'
    ) {
      const fragment =
        typeof event.delta === 'string'
          ? event.delta
          : typeof event.arguments_delta === 'string'
            ? event.arguments_delta
            : typeof event.argumentsDelta === 'string'
              ? event.argumentsDelta
              : undefined;
      if (fragment !== undefined) {
        getFunctionCallKeys(event).forEach((key) =>
          appendFunctionCallArgs(key, fragment),
        );
      }
      return;
    }

    if (
      type === 'response.function_call_arguments.done' ||
      type === 'response.tool_call_arguments.done'
    ) {
      const full =
        typeof event.arguments === 'string'
          ? event.arguments
          : typeof event.delta === 'string'
            ? event.delta
            : undefined;
      if (full !== undefined) {
        getFunctionCallKeys(event).forEach((key) =>
          functionCallArgsByKey.set(key, full),
        );
      }
      return;
    }

    if (type === 'response.output_text.delta') {
      const fragment =
        event.delta !== undefined
          ? event.delta
          : event.text !== undefined
            ? event.text
            : event.output_text;
      if (fragment !== undefined) {
        appendIndexedText(event.output_index, event.content_index, fragment);
      }
      return;
    }

    if (type === 'response.output_text.done') {
      const fragment =
        event.text !== undefined
          ? event.text
          : event.output_text !== undefined
            ? event.output_text
            : event.delta;
      if (fragment !== undefined) {
        appendIndexedText(event.output_index, event.content_index, fragment);
      }
      return;
    }

    if (type.includes('reasoning')) {
      const fragment =
        event.delta !== undefined
          ? event.delta
          : event.text !== undefined
            ? event.text
            : event.reasoning_text;
      if (fragment !== undefined) {
        reasoning += normaliseContent(fragment);
      }
    }
  });

  const mergedText = Array.from(textByIndex.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, value]) => value)
    .join('');

  const responseOutput = Array.isArray(latestResponse?.output)
    ? latestResponse.output
    : [];
  const outputFromResponse = responseOutput.length > 0;
  const outputFromEvents = Array.from(outputItemsByIndex.entries())
    .sort((a, b) => {
      const left = typeof a[0] === 'number' ? a[0] : Number(String(a[0]));
      const right = typeof b[0] === 'number' ? b[0] : Number(String(b[0]));
      const safeLeft = Number.isFinite(left) ? left : 0;
      const safeRight = Number.isFinite(right) ? right : 0;
      return safeLeft - safeRight;
    })
    .map(([, item]) => item)
    .filter(Boolean);
  const baseOutput = outputFromResponse ? responseOutput : outputFromEvents;
  const patchedOutput = ensureArray(baseOutput)
    .filter(Boolean)
    .map((item, index) => patchFunctionCallArguments(item, index));

  const syntheticOutput =
    patchedOutput.length > 0
      ? []
      : Array.from(functionCallArgsByKey.entries())
          .filter(
            ([key, value]) =>
              typeof key === 'string' &&
              key.startsWith('output_index:') &&
              typeof value === 'string' &&
              value.trim(),
          )
          .sort((a, b) => {
            const left = Number(a[0].slice('output_index:'.length));
            const right = Number(b[0].slice('output_index:'.length));
            const safeLeft = Number.isFinite(left) ? left : 0;
            const safeRight = Number.isFinite(right) ? right : 0;
            return safeLeft - safeRight;
          })
          .map(([key, value]) => {
            const outputIndex = Number(key.slice('output_index:'.length));
            return {
              type: 'function_call',
              output_index: Number.isFinite(outputIndex)
                ? outputIndex
                : undefined,
              name: 'function_call',
              arguments: value,
            };
          });
  const effectiveOutput =
    patchedOutput.length > 0 ? patchedOutput : syntheticOutput;

  if (effectiveOutput.length > 0) {
    const message = {
      role: latestResponse?.role || 'assistant',
      output: effectiveOutput,
    };
    if (!outputFromResponse && mergedText.trim()) {
      message.content = mergedText;
    }
    if (reasoning.trim()) {
      message.reasoning = reasoning;
    }
    return message;
  }

  if (!mergedText.trim()) {
    const responseTextSource =
      latestResponse?.output_text ?? latestResponse?.outputText;
    const fallbackText =
      responseTextSource !== undefined
        ? normaliseContent(responseTextSource)
        : typeof latestResponse?.text === 'string'
          ? normaliseContent(latestResponse.text)
          : latestResponse?.content !== undefined
            ? normaliseContent(latestResponse.content)
            : latestResponse?.output_texts !== undefined
              ? normaliseContent(latestResponse.output_texts)
              : '';
    if (
      fallbackText &&
      typeof fallbackText === 'string' &&
      fallbackText.trim()
    ) {
      return {
        role: latestResponse?.role || 'assistant',
        content: fallbackText,
        reasoning: reasoning.trim() ? reasoning : undefined,
      };
    }
  }

  if (!mergedText.trim() && !reasoning.trim()) {
    return null;
  }

  const message = { role: 'assistant' };

  if (mergedText.trim()) {
    message.content = mergedText;
  }

  if (reasoning.trim()) {
    message.reasoning = reasoning;
  }

  return message;
};

const aggregateClaudeStreamEvents = (events) => {
  if (!Array.isArray(events) || events.length === 0) {
    return null;
  }

  const blocks = new Map();
  let role = 'assistant';
  let reasoning = '';

  const getBlock = (index) => {
    if (!blocks.has(index)) {
      blocks.set(index, {
        type: 'text',
        text: '',
        name: undefined,
        id: undefined,
        input: undefined,
        partialJson: '',
        content: undefined,
        reasoning: '',
      });
    }
    return blocks.get(index);
  };

  events.forEach((event) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    const type = event.type;
    switch (type) {
      case 'message_start':
        role = event.message?.role || role;
        break;
      case 'content_block_start': {
        const index = event.index ?? blocks.size;
        const block = getBlock(index);
        block.type = event.content_block?.type || block.type;
        block.text = event.content_block?.text || '';
        block.name = event.content_block?.name;
        block.id = event.content_block?.id;
        block.input = event.content_block?.input;
        block.content = event.content_block?.content;
        block.reasoning = event.content_block?.thinking || '';
        break;
      }
      case 'content_block_delta': {
        const index = event.index ?? 0;
        const block = getBlock(index);
        const delta = event.delta || {};
        switch (delta.type) {
          case 'text_delta':
            block.type = block.type || 'text';
            block.text = (block.text || '') + (delta.text || '');
            break;
          case 'thinking_delta':
            block.reasoning = (block.reasoning || '') + (delta.thinking || '');
            break;
          case 'input_json_delta':
            block.partialJson =
              (block.partialJson || '') +
              (delta.partial_json ?? delta.partialJson ?? '');
            break;
          case 'tool_use_delta':
            block.partialJson =
              (block.partialJson || '') + (delta.arguments || '');
            break;
          default:
            if (delta.text) {
              block.text = (block.text || '') + delta.text;
            }
            break;
        }
        break;
      }
      case 'content_block_stop': {
        const index = event.index ?? 0;
        const block = getBlock(index);
        if (block.partialJson) {
          const parsed = safeParseJson(block.partialJson);
          block.input = parsed ?? block.partialJson;
        }
        break;
      }
      case 'message_delta':
        if (event.delta?.role) {
          role = event.delta.role;
        }
        if (event.delta?.reasoning) {
          reasoning += normaliseContent(event.delta.reasoning);
        }
        break;
      case 'message_stop':
        if (event.message?.role) {
          role = event.message.role;
        }
        break;
      default:
        break;
    }
  });

  const sortedBlocks = Array.from(blocks.entries()).sort((a, b) => a[0] - b[0]);

  const content = sortedBlocks
    .filter(([, block]) => block.type !== 'reasoning')
    .map(([, block]) => {
      if (block.reasoning) {
        reasoning += block.reasoning;
      }
      if (block.type === 'text' || !block.type) {
        return { type: 'text', text: block.text || '' };
      }
      if (block.type === 'tool_use') {
        const input =
          block.input !== undefined
            ? block.input
            : block.partialJson && block.partialJson.trim()
              ? block.partialJson
              : undefined;
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input,
        };
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          id: block.id,
          name: block.name,
          content: block.content ?? block.text ?? block.input,
        };
      }
      return {
        type: block.type,
        content: block.content ?? block.text ?? block.input,
      };
    });

  const message = { role };

  if (content.length > 0) {
    message.content = content;
  }

  if (reasoning.trim()) {
    message.reasoning = reasoning;
  }

  return message;
};

const buildMessageFromStreamObjects = (streamObjects) => {
  if (!Array.isArray(streamObjects) || streamObjects.length === 0) {
    return null;
  }

  if (streamObjects.some((obj) => Array.isArray(obj?.choices))) {
    return aggregateOpenAIStreamChunks(streamObjects);
  }

  if (
    streamObjects.some(
      (obj) =>
        typeof obj?.type === 'string' && obj.type.startsWith('response.'),
    )
  ) {
    return aggregateResponsesStreamEvents(streamObjects);
  }

  if (streamObjects.some((obj) => typeof obj?.type === 'string')) {
    return aggregateClaudeStreamEvents(streamObjects);
  }

  return null;
};

const collectRequestMessages = (requestObject) => {
  if (!requestObject) {
    return [];
  }

  const messages = [];

  const pushMessage = (source, fallbackRole) => {
    const message = buildMessageFromSource(source, fallbackRole);
    if (message.segments.length === 0 && !message.text) {
      const fallbackContent = normaliseContent(
        source?.content ?? source?.text ?? source,
      );
      if (fallbackContent && fallbackContent.trim()) {
        const fallbackSegment = createTextSegment(fallbackContent);
        messages.push({
          role: source?.role || fallbackRole || 'user',
          segments: fallbackSegment ? [fallbackSegment] : [],
          text: fallbackContent,
        });
      }
      return;
    }
    messages.push(message);
  };

  if (Array.isArray(requestObject.messages)) {
    requestObject.messages.forEach((message) => {
      if (!message) {
        return;
      }
      pushMessage(message, message.role || 'user');
    });
  }

  if (requestObject.input !== undefined) {
    const input = requestObject.input;
    if (Array.isArray(input)) {
      input.forEach((node) => {
        if (node === undefined || node === null) {
          return;
        }
        if (typeof node === 'string') {
          pushMessage({ role: 'user', content: node }, 'user');
          return;
        }
        pushMessage(node, node.role || node.type || 'user');
      });
    } else if (typeof input === 'string') {
      pushMessage({ role: 'user', content: input }, 'user');
    } else if (typeof input === 'object') {
      pushMessage(
        { ...input, role: input.role || input.type || 'user' },
        input.role || input.type || 'user',
      );
    }
  }

  if (messages.length === 0 && requestObject.prompt) {
    pushMessage({ role: 'user', content: requestObject.prompt }, 'user');
  }

  return messages;
};

const collectResponseUsage = (responseObject, streamObjects) => {
  if (responseObject?.usage) {
    return responseObject.usage;
  }
  if (Array.isArray(streamObjects)) {
    const withUsage = [...streamObjects]
      .reverse()
      .find((obj) => obj?.usage || obj?.response?.usage);
    if (withUsage?.usage) {
      return withUsage.usage;
    }
    if (withUsage?.response?.usage) {
      return withUsage.response.usage;
    }
  }
  return null;
};

const collectResponseMessages = (responseObject, streamObjects) => {
  const messages = [];

  const pushMessage = (source, fallbackRole) => {
    if (!source) {
      return;
    }
    const message = buildMessageFromSource(source, fallbackRole);
    if (message.segments.length === 0 && !message.text) {
      const fallbackContent = normaliseContent(
        source?.content ?? source?.text ?? source?.delta?.content ?? source,
      );
      if (fallbackContent && fallbackContent.trim()) {
        const fallbackSegment = createTextSegment(fallbackContent);
        messages.push({
          role: source?.role || fallbackRole || 'assistant',
          segments: fallbackSegment ? [fallbackSegment] : [],
          text: fallbackContent,
        });
      }
      return;
    }
    messages.push(message);
  };

  if (responseObject?.choices) {
    responseObject.choices.forEach((choice) => {
      if (!choice) {
        return;
      }
      if (choice.message) {
        pushMessage(choice.message, choice.message.role || 'assistant');
      } else if (choice.delta) {
        pushMessage(choice.delta, choice.delta.role || 'assistant');
      }
    });
  }

  if (Array.isArray(responseObject)) {
    responseObject.forEach((item) => {
      if (!item) {
        return;
      }
      const role = item.role || responseObject.role || 'assistant';
      pushMessage({ ...item, role }, role);
    });
  }

  if (responseObject?.content !== undefined) {
    pushMessage(responseObject, responseObject.role || 'assistant');
  }

  if (responseObject?.output) {
    ensureArray(responseObject.output).forEach((item) => {
      if (!item) {
        return;
      }
      const role = item.role || responseObject.role || 'assistant';
      pushMessage({ ...item, role }, role);
    });
  }

  if (
    messages.length === 0 &&
    (responseObject?.output_text !== undefined ||
      responseObject?.outputText !== undefined)
  ) {
    pushMessage(
      {
        role: responseObject?.role || 'assistant',
        content: responseObject?.output_text ?? responseObject?.outputText,
      },
      responseObject?.role || 'assistant',
    );
  }

  if (responseObject?.message) {
    pushMessage(
      responseObject.message,
      responseObject.message.role || 'assistant',
    );
  }

  if (responseObject?.result) {
    pushMessage(
      responseObject.result,
      responseObject.result.role || 'assistant',
    );
  }

  if (Array.isArray(responseObject?.messages)) {
    responseObject.messages.forEach((item) => {
      pushMessage(item, item?.role || 'assistant');
    });
  }

  if (responseObject?.completion) {
    pushMessage(
      {
        role: responseObject.role || 'assistant',
        content: responseObject.completion,
      },
      responseObject.role || 'assistant',
    );
  }

  if (responseObject?.reply) {
    pushMessage(
      {
        role: responseObject.role || 'assistant',
        content: responseObject.reply,
      },
      responseObject.role || 'assistant',
    );
  }

  if (
    messages.length === 0 &&
    Array.isArray(streamObjects) &&
    streamObjects.length > 0
  ) {
    const streamMessage = buildMessageFromStreamObjects(streamObjects);
    if (streamMessage) {
      pushMessage(streamMessage, streamMessage.role || 'assistant');
    }
  }

  return messages;
};

const buildRequestParams = (requestObject, t) => {
  if (!requestObject) {
    return [];
  }
  const params = [];
  const pushIfPresent = (label, value) => {
    if (value !== undefined && value !== null && value !== '') {
      params.push({ key: label, value: decodeUnicodeEscapes(String(value)) });
    }
  };

  pushIfPresent(t('模型'), requestObject.model);
  pushIfPresent(t('流式输出'), requestObject.stream);
  pushIfPresent(t('温度'), requestObject.temperature);
  pushIfPresent('top_p', requestObject.top_p);
  pushIfPresent(t('最大Tokens'), requestObject.max_tokens);
  pushIfPresent('max_output_tokens', requestObject.max_output_tokens);
  pushIfPresent(t('响应格式'), requestObject.response_format);
  if (requestObject.tools) {
    let count = 0;
    if (Array.isArray(requestObject.tools)) {
      count = requestObject.tools.length;
    } else if (typeof requestObject.tools === 'string') {
      const parsed = safeParseJson(requestObject.tools);
      if (Array.isArray(parsed)) {
        count = parsed.length;
      } else if (parsed) {
        count = 1;
      }
    } else {
      count = 1;
    }
    pushIfPresent(t('工具数量'), count);
  }
  if (requestObject.user) {
    pushIfPresent(t('用户'), requestObject.user);
  }
  return params;
};

const CollapsibleText = ({
  text,
  t,
  isCode = false,
  maxLines = 6,
  highlightQuery = '',
  autoExpandOnSearch = true,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(true);

  const queryLower = normalizeSearchQuery(highlightQuery);
  const canAutoExpand =
    Boolean(autoExpandOnSearch) &&
    Boolean(queryLower) &&
    typeof text === 'string' &&
    text.toLowerCase().includes(queryLower);

  useEffect(() => {
    if (canAutoExpand) {
      setExpanded(true);
    }
  }, [canAutoExpand]);

  if (!text || text.trim() === '') {
    return <Text type='tertiary'>{t('暂无数据')}</Text>;
  }

  const lines = text.split('\n');
  const shouldTruncate = lines.length > maxLines || text.length > 600;
  const displayedText =
    shouldTruncate && !expanded ? lines.slice(0, maxLines).join('\n') : text;

  const rendered = renderHighlightedText(displayedText, highlightQuery);

  return (
    <div className='flex flex-col gap-2 w-full'>
      {isCode ? (
        <pre
          className={`font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3 ${wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}`}
          style={{ maxHeight: 'clamp(240px, 45vh, 520px)', overflow: 'auto' }}
        >
          {rendered}
        </pre>
      ) : (
        <Paragraph
          style={{ marginBottom: 0, whiteSpace: 'pre-wrap', lineHeight: '22px' }}
        >
          {rendered}
        </Paragraph>
      )}
      <Space>
        {shouldTruncate ? (
          <Button
            size='small'
            type='tertiary'
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? t('收起') : t('展开')}
          </Button>
        ) : null}
        {isCode ? (
          <Button
            size='small'
            type='tertiary'
            onClick={() => setWrap((prev) => !prev)}
          >
            {wrap ? t('关闭换行') : t('开启换行')}
          </Button>
        ) : null}
      </Space>
    </div>
  );
};

const ToolsSummary = ({ tools, t }) => {
  let toolsArray = [];
  if (Array.isArray(tools)) {
    toolsArray = tools;
  } else if (typeof tools === 'string') {
    const parsed = safeParseJson(tools);
    if (Array.isArray(parsed)) {
      toolsArray = parsed;
    } else if (parsed) {
      toolsArray = [parsed];
    }
  } else if (tools) {
    toolsArray = [tools];
  }

  if (!toolsArray || toolsArray.length === 0) {
    return null;
  }

  const renderToolPanel = (tool, index) => {
    let name = tool?.name;
    let description = tool?.description;
    let schema = tool?.parameters;
    if (!name && tool?.function) {
      name = tool.function.name;
    }
    if (!description && tool?.function) {
      description = tool.function.description;
    }
    if (!schema && tool?.function) {
      schema = tool.function.parameters;
    }
    if (!schema && tool?.input_schema) {
      schema = tool.input_schema;
    }

    const required = Array.isArray(schema?.required) ? schema.required : [];
    const properties = schema?.properties || {};
    const params = Object.keys(properties || {}).map((key) => {
      const prop = properties[key] || {};
      const type = Array.isArray(prop.type)
        ? prop.type.join('|')
        : typeof prop.type === 'string'
          ? prop.type
          : prop.enum
            ? 'enum'
            : prop.anyOf || prop.oneOf
              ? 'union'
              : 'any';
      return {
        key,
        type,
        required: required.includes(key),
        desc: prop.description || '',
      };
    });
    const headerRight = (
      <Space wrap spacing={8} className='mr-2'>
        {params.length > 0 ? (
          params.map((p) => (
            <Tag key={`param-pill-${index}-${p.key}`} type='ghost' color='blue'>
              {p.key}
            </Tag>
          ))
        ) : (
          <Text type='tertiary'>{t('暂无参数')}</Text>
        )}
      </Space>
    );

    const header = (
      <div className='w-full flex items-center justify-between'>
        <Space align='center' spacing={8}>
          <Text>{name || t('未命名工具')}</Text>
        </Space>
        {headerRight}
      </div>
    );

    const content = (
      <div className='w-full flex flex-col gap-8'>
        {description ? (
          <Paragraph style={{ marginBottom: 0 }}>{description}</Paragraph>
        ) : null}
        {params.length > 0 ? (
          <Space vertical align='start' style={{ width: '100%', gap: 8 }}>
            {params.map((p) => (
              <Space
                align='center'
                wrap
                spacing={8}
                key={`param-${name}-${p.key}`}
                style={{ width: '100%' }}
              >
                <Tag type='ghost' color='blue'>
                  {p.key}
                </Tag>
                <Tag type='ghost' color='purple'>
                  {p.type}
                </Tag>
                <Tag type='ghost' color={p.required ? 'orange' : 'green'}>
                  {p.required ? t('必填') : t('可选')}
                </Tag>
                {p.desc ? <Text type='tertiary'>{p.desc}</Text> : null}
              </Space>
            ))}
          </Space>
        ) : (
          <Text type='tertiary'>{t('暂无参数')}</Text>
        )}
      </div>
    );

    return (
      <Collapse.Panel header={header} itemKey={`tool-${index}`}>
        {content}
      </Collapse.Panel>
    );
  };

  return (
    <div className='w-full flex flex-col'>
      <Space align='center' spacing={8}>
        <Text strong>{t('工具清单')}</Text>
        <Tag type='ghost' color='orange'>
          {t('数量')}: {toolsArray.length}
        </Tag>
      </Space>
      <Collapse defaultActiveKey={[]}>
        {toolsArray.map((tool, index) => renderToolPanel(tool, index))}
      </Collapse>
    </div>
  );
};

const ParamsGrid = ({ data, t }) => {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return <Text type='tertiary'>{t('无请求参数')}</Text>;
  }
  return (
    <div className='grid grid-cols-1 md:grid-cols-4 gap-2 w-full'>
      {items.map((row, index) => (
        <div
          key={`param-${index}`}
          className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2'
        >
          <Text type='tertiary'>{row.key}</Text>
          <Paragraph style={{ marginBottom: 0 }}>{row.value}</Paragraph>
        </div>
      ))}
    </div>
  );
};

const MessageSegmentView = ({
  segment,
  t,
  highlightQuery = '',
  segmentUid = '',
  registerSegmentRef,
  activeHitUid = '',
  hitPulseNonce = 0,
}) => {
  if (!segment) {
    return null;
  }

  const isActive = Boolean(segmentUid) && segmentUid === activeHitUid;
  const animationName =
    hitPulseNonce % 2 === 0 ? 'usageHitPulseA' : 'usageHitPulseB';

  const content = (() => {
    switch (segment.type) {
      case 'text':
        return (
          <div className='w-full relative rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2'>
            <div className='absolute top-1 right-1 z-10 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity'>
              <Tooltip content={t('复制')}>
                <Button
                  size='small'
                  theme='borderless'
                  icon={<IconCopy />}
                  aria-label={t('复制')}
                  onClick={async () => {
                    const ok = await copyToClipboard(
                      getSegmentCopyText(segment, t),
                    );
                    if (ok) {
                      Toast.success(t('消息已复制到剪贴板'));
                    } else {
                      Toast.error(t('无法复制到剪贴板，请手动复制'));
                    }
                  }}
                />
              </Tooltip>
            </div>
            <div className='pr-10'>
              <CollapsibleText
                text={segment.value}
                t={t}
                highlightQuery={highlightQuery}
              />
            </div>
          </div>
        );
      case 'reasoning':
        return (
          <div className='w-full flex flex-col gap-2 rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2'>
            <Space
              align='center'
              style={{ width: '100%', justifyContent: 'space-between' }}
            >
              <Text type='tertiary'>{t('思考过程')}</Text>
              <Tooltip content={t('复制')}>
                <Button
                  size='small'
                  theme='borderless'
                  icon={<IconCopy />}
                  aria-label={t('复制')}
                  className='opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity'
                  onClick={async () => {
                    const ok = await copyToClipboard(
                      getSegmentCopyText(segment, t),
                    );
                    if (ok) {
                      Toast.success(t('消息已复制到剪贴板'));
                    } else {
                      Toast.error(t('无法复制到剪贴板，请手动复制'));
                    }
                  }}
                />
              </Tooltip>
            </Space>
            <CollapsibleText
              text={segment.value}
              t={t}
              highlightQuery={highlightQuery}
            />
          </div>
        );
      case 'tool_call':
        return (
          <div className='w-full flex flex-col gap-2 rounded-md border border-dashed border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2'>
            <Space align='center' wrap spacing={8}>
              <Text strong>{t('工具调用')}</Text>
              {segment.name ? (
                <Tag type='ghost' color='orange'>
                  {segment.name}
                </Tag>
              ) : null}
              {segment.id ? (
                <Tag type='ghost' color='yellow'>
                  {t('ID')}: {segment.id}
                </Tag>
              ) : null}
              <Tooltip content={t('复制')}>
                <Button
                  size='small'
                  theme='borderless'
                  icon={<IconCopy />}
                  aria-label={t('复制')}
                  onClick={async () => {
                    const ok = await copyToClipboard(
                      getSegmentCopyText(segment, t),
                    );
                    if (ok) {
                      Toast.success(t('消息已复制到剪贴板'));
                    } else {
                      Toast.error(t('无法复制到剪贴板，请手动复制'));
                    }
                  }}
                />
              </Tooltip>
            </Space>
            {(() => {
              const parsed = safeParseJson(segment.value);
              if (parsed && typeof parsed === 'object') {
                return (
                  <JsonViewer
                    data={parsed}
                    t={t}
                    highlightQuery={highlightQuery}
                  />
                );
              }
              return (
                <CollapsibleText
                  text={segment.value}
                  t={t}
                  isCode
                  highlightQuery={highlightQuery}
                />
              );
            })()}
          </div>
        );
      case 'tool_result':
        return (
          <div className='w-full flex flex-col gap-2 rounded-md border border-dashed border-[var(--semi-color-border)] bg-[var(--semi-color-fill-1)] px-3 py-2'>
            <Space align='center' wrap spacing={8}>
              <Text strong>{t('工具结果')}</Text>
              {segment.name ? (
                <Tag type='ghost' color='green'>
                  {segment.name}
                </Tag>
              ) : null}
              {segment.id ? (
                <Tag type='ghost' color='lime'>
                  {t('ID')}: {segment.id}
                </Tag>
              ) : null}
              <Tooltip content={t('复制')}>
                <Button
                  size='small'
                  theme='borderless'
                  icon={<IconCopy />}
                  aria-label={t('复制')}
                  onClick={async () => {
                    const ok = await copyToClipboard(
                      getSegmentCopyText(segment, t),
                    );
                    if (ok) {
                      Toast.success(t('消息已复制到剪贴板'));
                    } else {
                      Toast.error(t('无法复制到剪贴板，请手动复制'));
                    }
                  }}
                />
              </Tooltip>
            </Space>
            <CollapsibleText
              text={segment.value}
              t={t}
              isCode
              highlightQuery={highlightQuery}
            />
          </div>
        );
      case 'json':
        return (
          <div className='w-full flex flex-col gap-1'>
            <Space
              align='center'
              style={{ width: '100%', justifyContent: 'space-between' }}
            >
              {segment.label ? (
                <Text type='tertiary'>{t(segment.label)}</Text>
              ) : (
                <span />
              )}
              <Tooltip content={t('复制')}>
                <Button
                  size='small'
                  theme='borderless'
                  icon={<IconCopy />}
                  aria-label={t('复制')}
                  className='opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity'
                  onClick={async () => {
                    const ok = await copyToClipboard(
                      getSegmentCopyText(segment, t),
                    );
                    if (ok) {
                      Toast.success(t('消息已复制到剪贴板'));
                    } else {
                      Toast.error(t('无法复制到剪贴板，请手动复制'));
                    }
                  }}
                />
              </Tooltip>
            </Space>
            <CollapsibleText
              text={segment.value}
              t={t}
              isCode
              highlightQuery={highlightQuery}
            />
          </div>
        );
      default:
        return (
          <CollapsibleText
            text={segment.value ?? ''}
            t={t}
            highlightQuery={highlightQuery}
          />
        );
    }
  })();

  return (
    <div
      id={segmentUid ? `usage-seg-${segmentUid}` : undefined}
      data-usage-seg={segmentUid || undefined}
      ref={
        segmentUid && registerSegmentRef
          ? registerSegmentRef(segmentUid)
          : undefined
      }
      className='w-full group'
      style={
        isActive
          ? {
              animation: `${animationName} 900ms ease-out 1`,
              borderRadius: 8,
              outline: '2px solid var(--semi-color-primary)',
              outlineOffset: 2,
            }
          : undefined
      }
    >
      {content}
    </div>
  );
};

const MessageContent = ({
  message,
  t,
  highlightQuery = '',
  source,
  messageIndex,
  registerSegmentRef,
  activeHitUid,
  hitPulseNonce = 0,
}) => {
  if (!message) {
    return null;
  }

  const segmentsRaw = Array.isArray(message.segments) ? message.segments : [];
  const hasMeta =
    (source === 'request' || source === 'response') &&
    typeof messageIndex === 'number';

  if (segmentsRaw.length === 0) {
    if (message.text && message.text.trim()) {
      const pseudoSegment = { type: 'text', value: message.text };
      const segmentUid = hasMeta ? makeSegmentUid(source, messageIndex, 0) : '';
      return (
        <MessageSegmentView
          segment={pseudoSegment}
          t={t}
          highlightQuery={highlightQuery}
          segmentUid={segmentUid}
          registerSegmentRef={registerSegmentRef}
          activeHitUid={activeHitUid}
          hitPulseNonce={hitPulseNonce}
        />
      );
    }
    return <Text type='tertiary'>{t('暂无数据')}</Text>;
  }

  return (
    <Space vertical align='start' style={{ width: '100%' }} spacing={14}>
      {segmentsRaw.map((segment, segmentIndex) => {
        if (!segment) {
          return null;
        }

        const segmentUid = hasMeta
          ? makeSegmentUid(source, messageIndex, segmentIndex)
          : '';

        return (
          <MessageSegmentView
            key={segmentUid || `segment-${segment.type}-${segmentIndex}`}
            segment={segment}
            t={t}
            highlightQuery={highlightQuery}
            segmentUid={segmentUid}
            registerSegmentRef={registerSegmentRef}
            activeHitUid={activeHitUid}
            hitPulseNonce={hitPulseNonce}
          />
        );
      })}
    </Space>
  );
};

const RawView = ({
  t,
  requestRaw,
  responseRaw,
  responseJson,
  streamObjects,
}) => {
  const [wrapReq, setWrapReq] = useState(true);
  const [wrapRes, setWrapRes] = useState(true);
  const requestText = formatJsonString(requestRaw) || t('暂无数据');
  const responseText = (() => {
    if (responseJson) {
      return formatJsonString(responseRaw);
    }
    if (Array.isArray(streamObjects) && streamObjects.length > 0) {
      return streamObjects
        .map((obj) => JSON.stringify(obj, null, 2))
        .join('\n\n');
    }
    return responseRaw ? responseRaw.trim() : t('暂无数据');
  })();

  return (
    <Space vertical align='start' style={{ width: '100%', gap: 16 }}>
      <div style={{ width: '100%' }}>
        <Space
          align='center'
          style={{ width: '100%', justifyContent: 'space-between' }}
        >
          <Title heading={4}>{t('请求体')}</Title>
          <Space>
            <Button
              size='small'
              type='tertiary'
              onClick={async () => {
                const ok = await copyToClipboard(requestText);
                if (ok) {
                  Toast.success(t('消息已复制到剪贴板'));
                } else {
                  Toast.error(t('无法复制到剪贴板，请手动复制'));
                }
              }}
            >
              {t('复制')}
            </Button>
            <Button
              size='small'
              type='tertiary'
              onClick={() => setWrapReq((v) => !v)}
            >
              {wrapReq ? t('关闭换行') : t('开启换行')}
            </Button>
          </Space>
        </Space>
        <pre
          className={`font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3 ${wrapReq ? 'whitespace-pre-wrap' : 'whitespace-pre'}`}
          style={{ maxHeight: 'clamp(240px, 45vh, 520px)', overflow: 'auto' }}
        >
          {requestText}
        </pre>
      </div>
      <div style={{ width: '100%' }}>
        <Space
          align='center'
          style={{ width: '100%', justifyContent: 'space-between' }}
        >
          <Title heading={4}>{t('响应体')}</Title>
          <Space>
            <Button
              size='small'
              type='tertiary'
              onClick={async () => {
                const ok = await copyToClipboard(responseText);
                if (ok) {
                  Toast.success(t('消息已复制到剪贴板'));
                } else {
                  Toast.error(t('无法复制到剪贴板，请手动复制'));
                }
              }}
            >
              {t('复制')}
            </Button>
            <Button
              size='small'
              type='tertiary'
              onClick={() => setWrapRes((v) => !v)}
            >
              {wrapRes ? t('关闭换行') : t('开启换行')}
            </Button>
          </Space>
        </Space>
        <pre
          className={`font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3 ${wrapRes ? 'whitespace-pre-wrap' : 'whitespace-pre'}`}
          style={{ maxHeight: 'clamp(240px, 45vh, 520px)', overflow: 'auto' }}
        >
          {responseText}
        </pre>
      </div>
    </Space>
  );
};

const JsonNode = ({ label, value, t, depth = 0, highlightQuery = '' }) => {
  const [collapsed, setCollapsed] = useState(() => {
    if (Array.isArray(value)) {
      return value.length > 3;
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).length > 3;
    }
    return false;
  });
  const isComplex =
    Array.isArray(value) || (value && typeof value === 'object');

  const queryLower = normalizeSearchQuery(highlightQuery);

  useEffect(() => {
    if (!queryLower || !isComplex || !collapsed) {
      return;
    }

    const labelText =
      label !== undefined && label !== null ? String(label).toLowerCase() : '';
    if (labelText && labelText.includes(queryLower)) {
      setCollapsed(false);
      return;
    }

    let visited = 0;
    const maxNodes = 800;
    const maxDepth = 10;

    const walk = (val, currentDepth) => {
      if (visited > maxNodes || currentDepth > maxDepth) {
        return false;
      }
      visited += 1;

      if (val === undefined || val === null) {
        return false;
      }

      if (typeof val === 'string') {
        return val.toLowerCase().includes(queryLower);
      }

      if (typeof val === 'number' || typeof val === 'boolean') {
        return String(val).toLowerCase().includes(queryLower);
      }

      if (Array.isArray(val)) {
        return val.some((item) => walk(item, currentDepth + 1));
      }

      if (typeof val === 'object') {
        return Object.entries(val).some(([k, v]) => {
          if (String(k).toLowerCase().includes(queryLower)) {
            return true;
          }
          return walk(v, currentDepth + 1);
        });
      }

      return false;
    };

    if (walk(value, depth)) {
      setCollapsed(false);
    }
  }, [depth, isComplex, label, queryLower, value]);

  return (
    <div className='w-full'>
      <Space align='center' spacing={8} style={{ marginBottom: 8 }}>
        {label !== undefined ? (
          <Tag type='ghost' color='cyan'>
            {String(label)}
          </Tag>
        ) : null}
        {isComplex ? (
          <Button
            size='small'
            type='tertiary'
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? t('展开') : t('收起')}
          </Button>
        ) : null}
      </Space>
      {isComplex ? (
        collapsed ? null : Array.isArray(value) ? (
          <Space vertical align='start' style={{ width: '100%', gap: 8 }}>
            {value.map((item, idx) => (
              <div key={`idx-${idx}`} className='w-full'>
                <JsonNode
                  label={idx}
                  value={item}
                  t={t}
                  depth={depth + 1}
                  highlightQuery={highlightQuery}
                />
              </div>
            ))}
          </Space>
        ) : (
          <Space vertical align='start' style={{ width: '100%', gap: 8 }}>
            {Object.keys(value).map((k) => (
              <div key={`key-${k}`} className='w-full'>
                <JsonNode
                  label={k}
                  value={value[k]}
                  t={t}
                  depth={depth + 1}
                  highlightQuery={highlightQuery}
                />
              </div>
            ))}
          </Space>
        )
      ) : (
        <Paragraph
          style={{ marginBottom: 0, whiteSpace: 'pre-wrap', lineHeight: '22px' }}
        >
          {typeof value === 'string'
            ? renderHighlightedText(value, highlightQuery)
            : typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : ''}
        </Paragraph>
      )}
    </div>
  );
};

const JsonViewer = ({ data, t, highlightQuery = '' }) => {
  if (data === undefined || data === null) {
    return <Text type='tertiary'>{t('暂无数据')}</Text>;
  }
  return (
    <div className='w-full rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] p-3'>
      <JsonNode value={data} t={t} highlightQuery={highlightQuery} />
    </div>
  );
};

const AnchorNav = ({ t, anchors }) => {
  const items = [
    { key: 'params', label: t('请求参数'), ref: anchors?.paramsRef },
    { key: 'req', label: t('请求消息'), ref: anchors?.reqMsgsRef },
    {
      key: 'respOverview',
      label: t('响应概览'),
      ref: anchors?.respOverviewRef,
    },
    { key: 'resp', label: t('响应消息'), ref: anchors?.respMsgsRef },
  ];
  return (
    <Space wrap spacing={8}>
      {items.map((item) => (
        <Button
          key={item.key}
          size='small'
          type='tertiary'
          onClick={() =>
            item.ref?.current?.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
            })
          }
        >
          {item.label}
        </Button>
      ))}
    </Space>
  );
};

const buildFormattedView = ({
  t,
  requestJson,
  responseJson,
  requestMessages,
  responseMessages,
  responseUsage,
  onCopyMessage,
  anchors,
}) => {
  const renderMessageList = (
    messages,
    emptyText,
    keyPrefix,
    tagColor,
    containerClassName,
  ) => {
    if (!messages || messages.length === 0) {
      return <Text type='tertiary'>{emptyText}</Text>;
    }

    return messages.map((message, index) => (
      <div
        key={`${keyPrefix}-${index}`}
        className={`relative group ${containerClassName}`}
      >
        <Space align='start' style={{ width: '100%', gap: 12 }}>
          <Tag type='ghost' color={tagColor}>
            {message.role}
          </Tag>
          <div style={{ flex: 1, width: '100%' }}>
            <MessageContent message={message} t={t} />
          </div>
        </Space>
        <Tooltip content={t('复制')}>
          <Button
            size='small'
            theme='borderless'
            icon={<IconCopy />}
            aria-label={t('复制')}
            className='absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity'
            onClick={() => onCopyMessage && onCopyMessage(message)}
          />
        </Tooltip>
      </div>
    ));
  };

  return (
    <div className='w-full flex flex-col gap-16'>
      <div ref={anchors?.paramsRef} style={{ width: '100%' }}>
        <Title heading={4}>{t('请求参数')}</Title>
        <Descriptions
          data={buildRequestParams(requestJson, t)}
          size='small'
          style={{ width: '100%' }}
          emptyContent={t('无请求参数')}
        />
        {(() => {
          const toolsRaw = requestJson?.tools;
          if (!toolsRaw) {
            return null;
          }
          return <ToolsSummary tools={toolsRaw} t={t} />;
        })()}
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 gap-16 w-full'>
        <div className='flex flex-col gap-12' ref={anchors?.reqMsgsRef}>
          <Title heading={4}>{t('请求消息')}</Title>
          <Space vertical align='start' style={{ width: '100%', gap: 12 }}>
            {renderMessageList(
              requestMessages,
              t('该请求没有消息内容'),
              'request-msg',
              'purple',
              'rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2 w-full',
            )}
          </Space>
        </div>

        <div className='flex flex-col gap-12'>
          <div ref={anchors?.respOverviewRef}>
            <Title heading={4}>{t('响应概览')}</Title>
            <Descriptions
              data={(() => {
                const rows = [];
                if (responseJson?.model) {
                  rows.push({ key: t('实际模型'), value: responseJson.model });
                }
                if (responseUsage) {
                  if (responseUsage.prompt_tokens !== undefined) {
                    rows.push({
                      key: t('提示Tokens'),
                      value: responseUsage.prompt_tokens,
                    });
                  }
                  if (responseUsage.completion_tokens !== undefined) {
                    rows.push({
                      key: t('补全Tokens'),
                      value: responseUsage.completion_tokens,
                    });
                  }
                  if (responseUsage.total_tokens !== undefined) {
                    rows.push({
                      key: t('总Tokens'),
                      value: responseUsage.total_tokens,
                    });
                  }
                }
                if (rows.length === 0) {
                  rows.push({ key: t('状态'), value: t('未提供响应统计信息') });
                }
                return rows;
              })()}
              size='small'
              style={{ width: '100%' }}
            />
          </div>

          <div ref={anchors?.respMsgsRef}>
            <Title heading={4}>{t('响应消息')}</Title>
            <Space vertical align='start' style={{ width: '100%', gap: 12 }}>
              {renderMessageList(
                responseMessages,
                t('该响应没有消息内容'),
                'response-msg',
                'blue',
                'rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-1)] px-3 py-2 w-full',
              )}
            </Space>
          </div>
        </div>
      </div>
    </div>
  );
};

const UsageLogDetailDrawer = ({
  visible,
  onClose,
  viewMode,
  onViewModeChange,
  log,
  t,
}) => {
  const isMobile = useIsMobile();

  const requestRaw = log?.detail?.request_body || '';
  const responseRaw = log?.detail?.response_body || '';

  const requestJson = useMemo(() => safeParseJson(requestRaw), [requestRaw]);
  const responseJson = useMemo(() => safeParseJson(responseRaw), [responseRaw]);
  const isSingleStreamObject = useMemo(
    () => looksLikeStreamObject(responseJson),
    [responseJson],
  );
  const streamObjects = useMemo(() => {
    if (responseJson && isSingleStreamObject) {
      return [responseJson];
    }
    if (Array.isArray(responseJson)) {
      const candidates = responseJson.filter((item) =>
        looksLikeStreamObject(item),
      );
      if (candidates.length > 0) {
        return candidates;
      }
      const nestedCandidates = responseJson
        .map((item) => item?.events ?? item?.data ?? item?.chunks)
        .find(
          (value) => Array.isArray(value) && value.some(looksLikeStreamObject),
        );
      if (Array.isArray(nestedCandidates)) {
        return nestedCandidates.filter(Boolean);
      }
    }
    if (responseJson && typeof responseJson === 'object') {
      const container =
        responseJson.events ?? responseJson.data ?? responseJson.chunks;
      if (Array.isArray(container) && container.some(looksLikeStreamObject)) {
        return container.filter(Boolean);
      }
    }
    if (!responseJson) {
      return splitStreamingResponse(responseRaw);
    }
    return [];
  }, [isSingleStreamObject, responseJson, responseRaw]);
  const effectiveResponseJson = useMemo(() => {
    if (isSingleStreamObject) {
      return null;
    }
    if (Array.isArray(streamObjects) && streamObjects.length > 0) {
      return null;
    }
    return responseJson;
  }, [isSingleStreamObject, responseJson, streamObjects]);

  const requestMessages = useMemo(
    () => collectRequestMessages(requestJson),
    [requestJson],
  );
  const responseMessages = useMemo(
    () => collectResponseMessages(effectiveResponseJson, streamObjects),
    [effectiveResponseJson, streamObjects],
  );
  const responseUsage = useMemo(
    () => collectResponseUsage(effectiveResponseJson, streamObjects),
    [effectiveResponseJson, streamObjects],
  );

  const other = useMemo(() => {
    const raw = log?.other;
    if (!raw) {
      return null;
    }
    if (typeof raw === 'object') {
      return raw;
    }
    if (typeof raw === 'string') {
      return safeParseJson(raw);
    }
    return null;
  }, [log?.other]);

  const toolInvocations = useMemo(() => {
    const invocations = [];
    const resultsById = new Map();
    const calls = [];

    const collect = (messages, source) => {
      if (!Array.isArray(messages)) {
        return;
      }
      messages.forEach((message, messageIndex) => {
        const segments = Array.isArray(message?.segments)
          ? message.segments
          : [];
        segments.forEach((segment, segmentIndex) => {
          if (!segment || typeof segment !== 'object') {
            return;
          }
          const id = segment.id ? String(segment.id) : '';
          if (segment.type === 'tool_result') {
            if (!id) {
              return;
            }
            const list = resultsById.get(id) || [];
            list.push({ segment, source, messageIndex, segmentIndex });
            resultsById.set(id, list);
            return;
          }
          if (segment.type === 'tool_call') {
            calls.push({ segment, source, messageIndex, segmentIndex, id });
          }
        });
      });
    };

    collect(requestMessages, 'request');
    collect(responseMessages, 'response');

    const usedResultIds = new Set();
    calls.forEach((call) => {
      const id = call.id;
      const results = id ? resultsById.get(id) || [] : [];
      if (id) {
        usedResultIds.add(id);
      }
      invocations.push({
        id,
        name: call.segment?.name,
        call,
        results,
      });
    });

    // Orphan results: results with id but no matching call
    resultsById.forEach((results, id) => {
      if (!usedResultIds.has(id)) {
        invocations.push({
          id,
          name: results[0]?.segment?.name,
          call: null,
          results,
        });
      }
    });

    return invocations;
  }, [requestMessages, responseMessages]);

  const hasStreamData =
    Boolean(log?.is_stream) ||
    Boolean(isSingleStreamObject) ||
    (Array.isArray(streamObjects) && streamObjects.length > 0);

  const paramsRef = useRef(null);
  const reqMsgsRef = useRef(null);
  const respOverviewRef = useRef(null);
  const respMsgsRef = useRef(null);
  const stickyHeaderRef = useRef(null);
  const mainScrollRef = useRef(null);

  const segmentRefs = useRef(new Map());
  const segmentRefCallbacks = useRef(new Map());
  const registerSegmentRef = useCallback((segmentUid) => {
    if (!segmentUid) {
      return undefined;
    }
    const cached = segmentRefCallbacks.current.get(segmentUid);
    if (cached) {
      return cached;
    }
    const cb = (node) => {
      if (node) {
        segmentRefs.current.set(segmentUid, node);
      } else {
        segmentRefs.current.delete(segmentUid);
      }
    };
    segmentRefCallbacks.current.set(segmentUid, cb);
    return cb;
  }, []);

  const [activeHitUid, setActiveHitUid] = useState('');
  const [activeHitIndex, setActiveHitIndex] = useState(0);
  const [hitPulseNonce, setHitPulseNonce] = useState(0);
  const [pendingJumpUid, setPendingJumpUid] = useState('');

  const [selectedMessageMeta, setSelectedMessageMeta] = useState(null);
  const [messageDetailOpen, setMessageDetailOpen] = useState(false);

  const handleCopyMessage = useCallback(
    async (message, format = 'full') => {
      const copyText = buildMessageCopyTextByFormat(message, t, format);
      if (!copyText) {
        Toast.warning(t('暂无数据'));
        return;
      }

      const success = await copyToClipboard(copyText);
      if (success) {
        Toast.success(t('消息已复制到剪贴板'));
      } else {
        Toast.error(t('无法复制到剪贴板，请手动复制'));
      }
    },
    [t],
  );

  const getMessageCompactSummary = useCallback(
    (message) => {
      if (!message) {
        return '';
      }

      const normalizePreview = (value, maxLen = 240) => {
        if (value === undefined || value === null) {
          return '';
        }

        const raw = String(value);
        const lines = raw.split('\n');
        const meaningful = lines
          .map((line) => String(line).trim())
          .find((line) => line && !/^[\[\]{}],?$/.test(line));

        const picked = meaningful ?? String(lines[0] || '').trim();
        const collapsed = picked
          .replace(/\s+/g, ' ')
          .replace(/,$/, '')
          .trim();

        if (!collapsed || /^[\[\]{}],?$/.test(collapsed)) {
          return '';
        }

        return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
      };

      const fromText = normalizePreview(message.text, 320);
      if (fromText) {
        return fromText;
      }

      const segments = Array.isArray(message.segments) ? message.segments : [];
      const firstSegment = segments.find(Boolean);
      if (!firstSegment) {
        return '';
      }

      if (firstSegment.type === 'text' || firstSegment.type === 'reasoning') {
        return normalizePreview(firstSegment.value, 320);
      }

      if (firstSegment.type === 'tool_call') {
        const name = firstSegment.name || firstSegment.id || '';
        const head = name ? `${t('工具调用')}: ${name}` : t('工具调用');
        const preview = normalizePreview(firstSegment.value, 240);
        return preview ? `${head} · ${preview}` : head;
      }

      if (firstSegment.type === 'tool_result') {
        const name = firstSegment.name || firstSegment.id || '';
        const head = name ? `${t('工具结果')}: ${name}` : t('工具结果');
        const preview = normalizePreview(firstSegment.value, 240);
        return preview ? `${head} · ${preview}` : head;
      }

      if (firstSegment.type === 'json') {
        const label = firstSegment.label ? String(firstSegment.label) : '';
        const head = label ? `${t('JSON')}: ${label}` : t('JSON');
        const preview = normalizePreview(firstSegment.value, 240);
        return preview ? `${head} · ${preview}` : head;
      }

      const fallback = normalizePreview(firstSegment.value, 240);
      if (fallback) {
        return firstSegment.type ? `${firstSegment.type} · ${fallback}` : fallback;
      }
      return firstSegment.type ? String(firstSegment.type) : '';
    },
    [t],
  );

  const openMessageDetail = useCallback(
    (source, messageIndex) => {
      setSelectedMessageMeta({ source, messageIndex });
      if (isMobile) {
        setMessageDetailOpen(true);
      }
    },
    [isMobile],
  );

  const closeMessageDetail = useCallback(() => {
    setMessageDetailOpen(false);
  }, []);

  const selectedMessage = useMemo(() => {
    if (!selectedMessageMeta) {
      return null;
    }
    const { source, messageIndex } = selectedMessageMeta;
    const list = source === 'request' ? requestMessages : responseMessages;
    return Array.isArray(list) ? list[messageIndex] : null;
  }, [requestMessages, responseMessages, selectedMessageMeta]);

  const selectedMessageSourceColor = useMemo(() => {
    return selectedMessageMeta?.source === 'request' ? 'purple' : 'blue';
  }, [selectedMessageMeta]);

  const selectedMessagePositionLabel = useMemo(() => {
    if (!selectedMessageMeta) {
      return '';
    }

    const sourceLabel =
      selectedMessageMeta.source === 'request' ? t('请求') : t('响应');
    const index = selectedMessageMeta.messageIndex + 1;
    const total =
      selectedMessageMeta.source === 'request'
        ? Array.isArray(requestMessages)
          ? requestMessages.length
          : 0
        : Array.isArray(responseMessages)
          ? responseMessages.length
          : 0;

    return total ? `${sourceLabel} #${index}/${total}` : `${sourceLabel} #${index}`;
  }, [requestMessages, responseMessages, selectedMessageMeta, t]);

  const [searchValue, setSearchValue] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [isSearchComposing, setIsSearchComposing] = useState(false);

  const [toolsFilterOpen, setToolsFilterOpen] = useState(false);
  const [filterToolName, setFilterToolName] = useState('');
  const [filterCallId, setFilterCallId] = useState('');
  const [filterToolStatus, setFilterToolStatus] = useState('all');

  const toolNameOptions = useMemo(() => {
    const names = new Set();
    (toolInvocations || []).forEach((inv) => {
      if (inv?.name) {
        names.add(inv.name);
      }
    });
    return Array.from(names).sort();
  }, [toolInvocations]);

  const searchQuery = useMemo(() => {
    if (isSearchComposing) {
      return '';
    }
    return (searchValue || '').trim();
  }, [isSearchComposing, searchValue]);

  const [debouncedSearchQuery] = useDebounce(searchQuery, 150);
  const effectiveSearchQuery = useMemo(
    () => (searchQuery ? debouncedSearchQuery : ''),
    [debouncedSearchQuery, searchQuery],
  );

  const searchQueryLower = useMemo(
    () => normalizeSearchQuery(effectiveSearchQuery),
    [effectiveSearchQuery],
  );
  const shouldFilterBySearch = Boolean(searchQueryLower) && onlyMatches;

  const requestMessageItems = useMemo(
    () =>
      (requestMessages || []).map((message, messageIndex) => ({
        message,
        source: 'request',
        messageIndex,
      })),
    [requestMessages],
  );

  const responseMessageItems = useMemo(
    () =>
      (responseMessages || []).map((message, messageIndex) => ({
        message,
        source: 'response',
        messageIndex,
      })),
    [responseMessages],
  );

  const visibleRequestMessageItems = useMemo(() => {
    if (!shouldFilterBySearch) {
      return requestMessageItems;
    }
    return (requestMessageItems || []).filter(({ message }) => {
      if (!message) {
        return false;
      }
      if (includesSearch(message.role, searchQueryLower)) {
        return true;
      }
      if (includesSearch(message.text, searchQueryLower)) {
        return true;
      }
      const segments = Array.isArray(message.segments) ? message.segments : [];
      return segments.some((segment) => {
        if (!segment) {
          return false;
        }
        return (
          includesSearch(segment.type, searchQueryLower) ||
          includesSearch(segment.name, searchQueryLower) ||
          includesSearch(segment.id, searchQueryLower) ||
          includesSearch(segment.label, searchQueryLower) ||
          includesSearch(segment.value, searchQueryLower)
        );
      });
    });
  }, [requestMessageItems, searchQueryLower, shouldFilterBySearch]);

  const visibleResponseMessageItems = useMemo(() => {
    if (!shouldFilterBySearch) {
      return responseMessageItems;
    }
    return (responseMessageItems || []).filter(({ message }) => {
      if (!message) {
        return false;
      }
      if (includesSearch(message.role, searchQueryLower)) {
        return true;
      }
      if (includesSearch(message.text, searchQueryLower)) {
        return true;
      }
      const segments = Array.isArray(message.segments) ? message.segments : [];
      return segments.some((segment) => {
        if (!segment) {
          return false;
        }
        return (
          includesSearch(segment.type, searchQueryLower) ||
          includesSearch(segment.name, searchQueryLower) ||
          includesSearch(segment.id, searchQueryLower) ||
          includesSearch(segment.label, searchQueryLower) ||
          includesSearch(segment.value, searchQueryLower)
        );
      });
    });
  }, [responseMessageItems, searchQueryLower, shouldFilterBySearch]);

  useEffect(() => {
    if (!shouldFilterBySearch) {
      return;
    }
    if (!selectedMessageMeta) {
      return;
    }

    const items =
      selectedMessageMeta.source === 'response'
        ? visibleResponseMessageItems
        : visibleRequestMessageItems;

    const exists = (items || []).some(
      (item) =>
        item?.source === selectedMessageMeta.source &&
        item?.messageIndex === selectedMessageMeta.messageIndex,
    );

    if (!exists) {
      setSelectedMessageMeta(null);
      setMessageDetailOpen(false);
    }
  }, [
    selectedMessageMeta,
    shouldFilterBySearch,
    visibleRequestMessageItems,
    visibleResponseMessageItems,
  ]);

  const visibleToolInvocations = useMemo(() => {
    if (!shouldFilterBySearch) {
      return toolInvocations;
    }
    return (toolInvocations || []).filter((invocation) => {
      if (!invocation) {
        return false;
      }
      if (includesSearch(invocation.id, searchQueryLower)) {
        return true;
      }
      if (includesSearch(invocation.name, searchQueryLower)) {
        return true;
      }
      const callSegment = invocation.call?.segment;
      if (
        callSegment &&
        (includesSearch(callSegment.name, searchQueryLower) ||
          includesSearch(callSegment.id, searchQueryLower) ||
          includesSearch(callSegment.value, searchQueryLower))
      ) {
        return true;
      }
      const results = Array.isArray(invocation.results)
        ? invocation.results
        : [];
      return results.some((item) => {
        const seg = item?.segment;
        if (!seg) {
          return false;
        }
        return (
          includesSearch(seg.name, searchQueryLower) ||
          includesSearch(seg.id, searchQueryLower) ||
          includesSearch(seg.value, searchQueryLower)
        );
      });
    });
  }, [toolInvocations, searchQueryLower, shouldFilterBySearch]);

  const filteredToolInvocations = useMemo(() => {
    let invocations = Array.isArray(visibleToolInvocations)
      ? visibleToolInvocations
      : [];
    const callIdLower = normalizeSearchQuery(filterCallId);

    if (filterToolName) {
      invocations = invocations.filter((inv) => inv?.name === filterToolName);
    }
    if (callIdLower) {
      invocations = invocations.filter((inv) =>
        includesSearch(inv?.id, callIdLower),
      );
    }
    if (filterToolStatus !== 'all') {
      invocations = invocations.filter((inv) => {
        const hasCall = Boolean(inv?.call);
        const hasResults =
          Array.isArray(inv?.results) && inv.results.length > 0;
        if (filterToolStatus === 'missing_result') {
          return hasCall && !hasResults;
        }
        if (filterToolStatus === 'completed') {
          return hasCall && hasResults;
        }
        if (filterToolStatus === 'orphan_result') {
          return !hasCall;
        }
        return true;
      });
    }

    return invocations;
  }, [filterCallId, filterToolName, filterToolStatus, visibleToolInvocations]);

  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    setActiveTab('overview');
    setSearchValue('');
    setOnlyMatches(false);
    setIsSearchComposing(false);

    setActiveHitUid('');
    setActiveHitIndex(0);
    setHitPulseNonce(0);
    setPendingJumpUid('');

    setSelectedMessageMeta(null);
    setMessageDetailOpen(false);

    segmentRefs.current.clear();
    segmentRefCallbacks.current.clear();

    setToolsFilterOpen(false);
    setFilterToolName('');
    setFilterCallId('');
    setFilterToolStatus('all');
  }, [log?.id]);

  useEffect(() => {
    if (activeTab !== 'tools') {
      setToolsFilterOpen(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'messages') {
      setMessageDetailOpen(false);
    }
  }, [activeTab]);

  useEffect(() => {
    setActiveHitUid('');
    setActiveHitIndex(0);
  }, [searchQueryLower]);

  const handleModeChange = (next) => {
    const value =
      typeof next === 'string'
        ? next
        : typeof next === 'object' && next !== null
          ? next.target?.value
          : undefined;
    if (value) {
      onViewModeChange(value);
    }
  };

  const focusSearchInput = useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const el = document.querySelector('#usage-log-detail-search input');
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (typeof el.select === 'function') {
        el.select();
      }
    }
  }, []);

  const getDrawerScrollEl = useCallback(() => {
    return mainScrollRef.current;
  }, []);

  const scrollToSegmentUid = useCallback(
    (segmentUid) => {
      if (!segmentUid) {
        return false;
      }

      const el =
        segmentRefs.current.get(segmentUid) ||
        (typeof document !== 'undefined'
          ? document.getElementById(`usage-seg-${segmentUid}`)
          : null);

      if (!el) {
        return false;
      }

      const container =
        (typeof el.closest === 'function'
          ? el.closest('[data-usage-scroll-container]')
          : null) || getDrawerScrollEl();

      if (container) {
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const top = elRect.top - containerRect.top + container.scrollTop;
        container.scrollTo({
          top: Math.max(0, top - 8),
          behavior: 'smooth',
        });
        return true;
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    },
    [getDrawerScrollEl],
  );

  const hitList = useMemo(() => {
    if (!searchQueryLower) {
      return [];
    }

    const matchesSegment = (segment) => {
      if (!segment) {
        return false;
      }
      return (
        includesSearch(segment.type, searchQueryLower) ||
        includesSearch(segment.name, searchQueryLower) ||
        includesSearch(segment.id, searchQueryLower) ||
        includesSearch(segment.label, searchQueryLower) ||
        includesSearch(segment.value, searchQueryLower)
      );
    };

    const hits = [];

    if (activeTab === 'messages') {
      const collectFromItems = (items) => {
        (items || []).forEach((item) => {
          const message = item?.message;
          if (!message) {
            return;
          }

          const segments = Array.isArray(message.segments) ? message.segments : [];
          const source = item.source;
          const messageIndex = item.messageIndex;

          let matchedSegments = 0;
          segments.forEach((segment, segmentIndex) => {
            if (!segment) {
              return;
            }
            if (!matchesSegment(segment)) {
              return;
            }
            matchedSegments += 1;
            hits.push({
              segmentUid: makeSegmentUid(source, messageIndex, segmentIndex),
              source,
              messageIndex,
              segmentIndex,
            });
          });

          if (matchedSegments > 0) {
            return;
          }

          if (
            includesSearch(message.role, searchQueryLower) ||
            includesSearch(message.text, searchQueryLower)
          ) {
            const firstIndex = segments.findIndex(Boolean);
            const segmentIndex = firstIndex >= 0 ? firstIndex : 0;
            hits.push({
              segmentUid: makeSegmentUid(source, messageIndex, segmentIndex),
              source,
              messageIndex,
              segmentIndex,
            });
          }
        });
      };

      collectFromItems(visibleRequestMessageItems);
      collectFromItems(visibleResponseMessageItems);
      return hits;
    }

    if (activeTab === 'tools') {
      (filteredToolInvocations || []).forEach((inv) => {
        if (!inv) {
          return;
        }
        const results = Array.isArray(inv.results) ? inv.results : [];

        let matched = 0;
        const call = inv.call;
        if (call?.segment && matchesSegment(call.segment)) {
          matched += 1;
          hits.push({
            segmentUid: makeSegmentUid(call.source, call.messageIndex, call.segmentIndex),
            source: call.source,
            messageIndex: call.messageIndex,
            segmentIndex: call.segmentIndex,
          });
        }
        results.forEach((item) => {
          const seg = item?.segment;
          if (!seg || !matchesSegment(seg)) {
            return;
          }
          matched += 1;
          hits.push({
            segmentUid: makeSegmentUid(item.source, item.messageIndex, item.segmentIndex),
            source: item.source,
            messageIndex: item.messageIndex,
            segmentIndex: item.segmentIndex,
          });
        });

        if (matched > 0) {
          return;
        }

        if (
          includesSearch(inv.id, searchQueryLower) ||
          includesSearch(inv.name, searchQueryLower)
        ) {
          const target = call || results.find(Boolean);
          if (!target) {
            return;
          }
          hits.push({
            segmentUid: makeSegmentUid(target.source, target.messageIndex, target.segmentIndex),
            source: target.source,
            messageIndex: target.messageIndex,
            segmentIndex: target.segmentIndex,
          });
        }
      });
      return hits;
    }

    if (activeTab === 'stream') {
      const text = (Array.isArray(streamObjects) ? streamObjects : [])
        .map((obj) => JSON.stringify(obj, null, 2))
        .join('\n\n');
      if (includesSearch(text, searchQueryLower)) {
        return [
          { segmentUid: 'stream', source: 'response', messageIndex: 0, segmentIndex: 0 },
        ];
      }
      return [];
    }

    return [];
  }, [
    activeTab,
    filteredToolInvocations,
    searchQueryLower,
    streamObjects,
    visibleRequestMessageItems,
    visibleResponseMessageItems,
  ]);

  const hitCount = hitList.length;
  const hitPositionText =
    hitCount > 0 && activeHitUid
      ? `${activeHitIndex + 1}/${hitCount}`
      : `0/${hitCount}`;

  useEffect(() => {
    if (!activeHitUid) {
      return;
    }
    const idx = hitList.findIndex((hit) => hit.segmentUid === activeHitUid);
    if (idx === -1) {
      setActiveHitUid('');
      setActiveHitIndex(0);
      return;
    }
    if (idx !== activeHitIndex) {
      setActiveHitIndex(idx);
    }
  }, [activeHitIndex, activeHitUid, hitList]);

  const goToHitIndex = useCallback(
    (index) => {
      const hit = hitList[index];
      if (!hit) {
        return;
      }
      setActiveHitIndex(index);
      setActiveHitUid(hit.segmentUid);
      setHitPulseNonce((n) => n + 1);
      setPendingJumpUid(hit.segmentUid);
    },
    [hitList],
  );

  const goToNextHit = useCallback(() => {
    if (hitCount === 0) {
      return;
    }
    const current = activeHitUid ? activeHitIndex : -1;
    const nextIndex = (current + 1) % hitCount;
    goToHitIndex(nextIndex);
  }, [activeHitIndex, activeHitUid, goToHitIndex, hitCount]);

  const goToPrevHit = useCallback(() => {
    if (hitCount === 0) {
      return;
    }
    const current = activeHitUid ? activeHitIndex : 0;
    const prevIndex = (current - 1 + hitCount) % hitCount;
    goToHitIndex(prevIndex);
  }, [activeHitIndex, activeHitUid, goToHitIndex, hitCount]);

  useEffect(() => {
    if (!pendingJumpUid) {
      return;
    }

    const meta = parseSegmentUid(pendingJumpUid);
    if (meta) {
      if (activeTab !== 'messages') {
        setActiveTab('messages');
        return;
      }

      const isSelected =
        selectedMessageMeta?.source === meta.source &&
        selectedMessageMeta?.messageIndex === meta.messageIndex;
      if (!isSelected) {
        setSelectedMessageMeta({ source: meta.source, messageIndex: meta.messageIndex });
        return;
      }

      if (isMobile && !messageDetailOpen) {
        setMessageDetailOpen(true);
        return;
      }
    }

    let attempts = 0;
    let rafId = 0;
    const maxAttempts = 12;

    const tryScroll = () => {
      attempts += 1;

      if (scrollToSegmentUid(pendingJumpUid)) {
        setPendingJumpUid('');
        return;
      }

      if (attempts >= maxAttempts) {
        setPendingJumpUid('');
        return;
      }

      rafId = requestAnimationFrame(tryScroll);
    };

    tryScroll();
    return () => cancelAnimationFrame(rafId);
  }, [
    activeTab,
    isMobile,
    messageDetailOpen,
    pendingJumpUid,
    scrollToSegmentUid,
    selectedMessageMeta,
  ]);

  useEffect(() => {
    if (!visible || viewMode !== 'formatted') {
      return;
    }

    const onKeyDown = (e) => {
      const key = e.key;

      if ((e.metaKey || e.ctrlKey) && String(key).toLowerCase() === 'f') {
        e.preventDefault();
        focusSearchInput();
        return;
      }

      if (key === 'Escape') {
        if (isMobile && messageDetailOpen) {
          setMessageDetailOpen(false);
          e.preventDefault();
          return;
        }
        if (toolsFilterOpen) {
          setToolsFilterOpen(false);
          e.preventDefault();
          return;
        }
        if (searchValue || onlyMatches) {
          setSearchValue('');
          setOnlyMatches(false);
          e.preventDefault();
          return;
        }
        onClose?.();
        e.preventDefault();
        return;
      }

      if (isSearchComposing) {
        return;
      }

      if (key === 'Enter') {
        if (!searchQueryLower || hitCount === 0) {
          return;
        }

        const tag = e.target?.tagName?.toLowerCase();
        const isTextInput = tag === 'input' || tag === 'textarea';
        if (isTextInput) {
          const inSearch = e.target?.closest?.('#usage-log-detail-search');
          if (!inSearch) {
            return;
          }
        }

        e.preventDefault();
        if (e.shiftKey) {
          goToPrevHit();
        } else {
          goToNextHit();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    focusSearchInput,
    goToNextHit,
    goToPrevHit,
    hitCount,
    isMobile,
    isSearchComposing,
    messageDetailOpen,
    onClose,
    onlyMatches,
    searchQueryLower,
    searchValue,
    toolsFilterOpen,
    viewMode,
    visible,
  ]);

  return (
    <SideSheet
      placement='right'
      visible={visible}
      onCancel={onClose}
      width={isMobile ? '100vw' : 'clamp(360px, 92vw, 960px)'}
      maskClosable
      title={
        <div className='w-full flex items-center justify-between'>
          <Title heading={4} style={{ margin: 0 }}>
            {t('请求详情')}
          </Title>
          <RadioGroup
            type='button'
            buttonSize='small'
            value={viewMode}
            onChange={handleModeChange}
            className='mr-4'
          >
            <Radio value='formatted'>{t('格式化视图')}</Radio>
            <Radio value='raw'>{t('原始数据')}</Radio>
          </RadioGroup>
        </div>
      }
      className='usage-log-detail-drawer'
      closeIcon={
        <Button
          className='semi-button-tertiary semi-button-size-small semi-button-borderless'
          type='button'
          icon={<IconClose />}
          onClick={onClose}
        />
      }
      bodyStyle={{
        padding: isMobile ? '0 12px 12px 12px' : '0 24px 16px 24px',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Space
        vertical
        align='start'
        style={{ width: '100%', gap: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        {viewMode === 'formatted' ? (
          <>
            <div className='w-full shrink-0' ref={stickyHeaderRef}>
              <Tabs
                type='line'
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key)}
                className='w-full'
                style={{ width: '100%' }}
                tabBarStyle={{
                  background: 'var(--semi-color-bg-2)',
                  padding: 0,
                }}
              >
                <Tabs.TabPane tab={t('概览')} itemKey='overview' />
                <Tabs.TabPane tab={t('参数')} itemKey='params' />
                <Tabs.TabPane tab={t('消息')} itemKey='messages' />
                <Tabs.TabPane tab={t('工具链')} itemKey='tools' />
                <Tabs.TabPane tab={t('指标')} itemKey='metrics' />
                {hasStreamData ? (
                  <Tabs.TabPane tab={t('流式')} itemKey='stream' />
                ) : null}
              </Tabs>

              <div className='w-full bg-[var(--semi-color-bg-2)] border-b border-[var(--semi-color-border)] py-2'>
                <Space
                  align='center'
                  spacing={12}
                  style={{
                    width: '100%',
                    justifyContent: 'space-between',
                  }}
                >
                  <div id='usage-log-detail-search' style={{ flex: 1 }}>
                    <Input
                      prefix={<IconSearch />}
                      placeholder={t('搜索消息/工具/JSON')}
                      value={searchValue}
                      onChange={setSearchValue}
                      onCompositionStart={() => setIsSearchComposing(true)}
                      onCompositionEnd={() => setIsSearchComposing(false)}
                      showClear
                      size='small'
                    />
                  </div>
                  <Space align='center' spacing={8}>
                    {searchQuery ? (
                      <>
                        <Tag type='ghost' color='cyan'>
                          {t('命中')}: {hitCount} ({hitPositionText})
                        </Tag>
                        <Tooltip content={t('上一处')}>
                          <Button
                            size='small'
                            theme='borderless'
                            icon={<IconChevronUp />}
                            aria-label={t('上一处')}
                            disabled={hitCount === 0}
                            onClick={goToPrevHit}
                          />
                        </Tooltip>
                        <Tooltip content={t('下一处')}>
                          <Button
                            size='small'
                            theme='borderless'
                            icon={<IconChevronDown />}
                            aria-label={t('下一处')}
                            disabled={hitCount === 0}
                            onClick={goToNextHit}
                          />
                        </Tooltip>
                      </>
                    ) : null}
                    <Text type='tertiary'>{t('仅看命中')}</Text>
                    <Switch checked={onlyMatches} onChange={setOnlyMatches} />
                    {activeTab === 'tools' ? (
                      <Tooltip content={t('过滤')}>
                        <Button
                          theme='borderless'
                          icon={<IconFilter />}
                          aria-label={t('过滤')}
                          onClick={() => setToolsFilterOpen((v) => !v)}
                        />
                      </Tooltip>
                    ) : null}
                  </Space>
                </Space>

                {activeTab === 'tools' && toolsFilterOpen ? (
                  <div className='mt-2'>
                    <Space
                      align='center'
                      wrap
                      spacing={8}
                      style={{ width: '100%' }}
                    >
                      <Select
                        size='small'
                        value={filterToolName}
                        onChange={setFilterToolName}
                        placeholder={t('工具名')}
                        optionList={[
                          { value: '', label: t('全部工具') },
                          ...toolNameOptions.map((name) => ({
                            value: name,
                            label: name,
                          })),
                        ]}
                        style={{ minWidth: 180 }}
                      />
                      <Input
                        size='small'
                        value={filterCallId}
                        onChange={setFilterCallId}
                        placeholder={t('调用ID')}
                        showClear
                        style={{ minWidth: 180 }}
                      />
                      <Select
                        size='small'
                        value={filterToolStatus}
                        onChange={setFilterToolStatus}
                        placeholder={t('状态')}
                        optionList={[
                          { value: 'all', label: t('全部状态') },
                          { value: 'completed', label: t('已完成') },
                          { value: 'missing_result', label: t('缺少结果') },
                          { value: 'orphan_result', label: t('仅结果') },
                        ]}
                        style={{ minWidth: 140 }}
                      />
                      <Button
                        size='small'
                        type='tertiary'
                        onClick={() => {
                          setFilterToolName('');
                          setFilterCallId('');
                          setFilterToolStatus('all');
                        }}
                      >
                        {t('清除')}
                      </Button>
                    </Space>
                  </div>
                ) : null}
              </div>
            </div>

            <div
              ref={mainScrollRef}
              className='flex-1 min-h-0 overflow-auto w-full'
              data-usage-scroll-container='main'
            >
              {activeTab === 'overview' && (
              <Space vertical align='start' style={{ width: '100%', gap: 12 }}>
                <div className='grid grid-cols-1 md:grid-cols-2 gap-3 w-full'>
                  <div className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)] p-3'>
                    <Space
                      vertical
                      align='start'
                      style={{ width: '100%', gap: 8 }}
                    >
                      <Text strong>{t('请求')}</Text>
                      <Descriptions
                        size='small'
                        style={{ width: '100%' }}
                        data={(() => {
                          const rows = [];
                          if (log?.id !== undefined) {
                            rows.push({ key: t('ID'), value: log.id });
                          }
                          if (log?.timestamp2string) {
                            rows.push({
                              key: t('时间'),
                              value: log.timestamp2string,
                            });
                          } else if (log?.created_at) {
                            rows.push({
                              key: t('时间戳'),
                              value: log.created_at,
                            });
                          }
                          if (log?.username) {
                            rows.push({ key: t('用户'), value: log.username });
                          }
                          if (log?.token_name) {
                            rows.push({
                              key: t('令牌'),
                              value: log.token_name,
                            });
                          }
                          if (log?.model_name) {
                            rows.push({
                              key: t('模型'),
                              value: log.model_name,
                            });
                          }
                          if (log?.group) {
                            rows.push({ key: t('分组'), value: log.group });
                          }
                          if (log?.channel_name) {
                            rows.push({
                              key: t('渠道'),
                              value: log.channel_name,
                            });
                          }
                          if (log?.ip) {
                            rows.push({ key: t('IP'), value: log.ip });
                          }
                          if (rows.length === 0) {
                            rows.push({ key: t('状态'), value: t('暂无数据') });
                          }
                          return rows;
                        })()}
                      />
                    </Space>
                  </div>

                  <div className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)] p-3'>
                    <Space
                      vertical
                      align='start'
                      style={{ width: '100%', gap: 8 }}
                    >
                      <Text strong>{t('概览')}</Text>
                      <Descriptions
                        size='small'
                        style={{ width: '100%' }}
                        data={(() => {
                          const rows = [];
                          const promptTokens =
                            log?.prompt_tokens !== undefined
                              ? log.prompt_tokens
                              : responseUsage?.prompt_tokens;
                          const completionTokens =
                            log?.completion_tokens !== undefined
                              ? log.completion_tokens
                              : responseUsage?.completion_tokens;
                          if (promptTokens !== undefined) {
                            rows.push({
                              key: t('提示Tokens'),
                              value: promptTokens,
                            });
                          }
                          if (completionTokens !== undefined) {
                            rows.push({
                              key: t('补全Tokens'),
                              value: completionTokens,
                            });
                          }
                          if (responseUsage?.total_tokens !== undefined) {
                            rows.push({
                              key: t('总Tokens'),
                              value: responseUsage.total_tokens,
                            });
                          }
                          if (log?.quota !== undefined) {
                            rows.push({ key: t('消耗额度'), value: log.quota });
                          }
                          if (log?.use_time !== undefined) {
                            rows.push({
                              key: t('耗时'),
                              value: `${log.use_time}s`,
                            });
                          }
                          if (other?.frt !== undefined) {
                            rows.push({
                              key: t('首包时延'),
                              value: `${other.frt}s`,
                            });
                          }
                          if (hasStreamData) {
                            rows.push({ key: t('流式'), value: t('是') });
                          }
                          if (responseJson?.model) {
                            rows.push({
                              key: t('实际模型'),
                              value: responseJson.model,
                            });
                          }
                          if (rows.length === 0) {
                            rows.push({ key: t('状态'), value: t('暂无数据') });
                          }
                          return rows;
                        })()}
                      />
                    </Space>
                  </div>
                </div>

                {(() => {
                  const warnings = [];
                  if (!requestJson && requestRaw && requestRaw.trim()) {
                    warnings.push(t('请求体无法解析为JSON'));
                  }
                  if (
                    !responseJson &&
                    (!streamObjects || streamObjects.length === 0) &&
                    responseRaw &&
                    responseRaw.trim()
                  ) {
                    warnings.push(t('响应体无法解析为JSON'));
                  }
                  if (warnings.length === 0) {
                    return null;
                  }
                  return (
                    <Space wrap spacing={8}>
                      {warnings.map((item, idx) => (
                        <Tag key={`warn-${idx}`} type='ghost' color='orange'>
                          {item}
                        </Tag>
                      ))}
                    </Space>
                  );
                })()}
              </Space>
            )}

            {activeTab === 'params' && (
              <div style={{ width: '100%' }}>
                <ParamsGrid data={buildRequestParams(requestJson, t)} t={t} />
                {(() => {
                  const toolsRaw = requestJson?.tools;
                  if (!toolsRaw) {
                    return null;
                  }
                  return (
                    <div className='mt-6'>
                      <ToolsSummary tools={toolsRaw} t={t} />
                    </div>
                  );
                })()}
              </div>
            )}

            {activeTab === 'messages' && (
              <div className='relative w-full h-full min-h-0 overflow-hidden'>
                <div className='flex w-full h-full min-h-0 overflow-hidden'>
                  <div
                    className={`flex flex-col min-h-0 gap-2 ${isMobile ? 'w-full' : 'w-[380px] flex-none'}`}
                  >
                    <div ref={reqMsgsRef} className='flex flex-col min-h-0 flex-[7]'>
                      <div className='shrink-0 flex items-center justify-between'>
                        <Text strong>{t('请求消息')}</Text>
                        <Text type='tertiary' style={{ fontSize: 12 }}>
                          {(() => {
                            const totalCount = Array.isArray(requestMessageItems)
                              ? requestMessageItems.length
                              : 0;
                            const visibleCount = Array.isArray(visibleRequestMessageItems)
                              ? visibleRequestMessageItems.length
                              : 0;
                            return visibleCount === totalCount
                              ? String(totalCount)
                              : `${visibleCount}/${totalCount}`;
                          })()}
                        </Text>
                      </div>
                      <div className='flex-1 min-h-0 overflow-auto rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)]'>
                        {(() => {
                          const items = visibleRequestMessageItems;
                          if (!items || items.length === 0) {
                            return (
                              <div className='p-3'>
                                <Text type='tertiary'>
                                  {shouldFilterBySearch
                                    ? t('无匹配结果')
                                    : t('该请求没有消息内容')}
                                </Text>
                              </div>
                            );
                          }

                          return items.map((item) => {
                            const message = item?.message;
                            if (!message) {
                              return null;
                            }

                            const isSelected =
                              selectedMessageMeta?.source === item.source &&
                              selectedMessageMeta?.messageIndex === item.messageIndex;
                            const summary = getMessageCompactSummary(message);

                            return (
                              <button
                                key={`request-compact-${item.messageIndex}`}
                                type='button'
                                className={`relative w-full flex items-center gap-2 px-3 h-10 text-left border-b border-[var(--semi-color-border)] last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--semi-color-primary)] focus-visible:ring-inset ${isSelected ? 'bg-[var(--semi-color-fill-1)] border-l-2 border-l-[var(--semi-color-primary)]' : 'hover:bg-[var(--semi-color-fill-0)] border-l-2 border-l-transparent'}`}
                                onClick={() =>
                                  openMessageDetail(item.source, item.messageIndex)
                                }
                              >
                                {isSelected ? (
                                  <span
                                    aria-hidden
                                    className='absolute left-0 top-0 bottom-0 w-1 bg-[var(--semi-color-primary)]'
                                  />
                                ) : null}
                                <div className='w-20 flex-none overflow-hidden'>
                                  <Tag type='ghost' color='purple' className='whitespace-nowrap'>
                                    {message.role}
                                  </Tag>
                                </div>
                                <div className='flex-1 min-w-0 truncate text-sm'>
                                  {summary ? (
                                    renderHighlightedText(summary, effectiveSearchQuery)
                                  ) : (
                                    <span className='text-[var(--semi-color-text-2)]'>
                                      {t('暂无内容')}
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          });
                        })()}
                      </div>
                    </div>

                    <div
                      ref={respMsgsRef}
                      className='flex flex-col min-h-0 flex-[3] mt-2 pt-2 border-t border-[var(--semi-color-border)]'
                    >
                      <div className='shrink-0 flex items-center justify-between'>
                        <Text strong>{t('响应消息')}</Text>
                        <Text type='tertiary' style={{ fontSize: 12 }}>
                          {(() => {
                            const totalCount = Array.isArray(responseMessageItems)
                              ? responseMessageItems.length
                              : 0;
                            const visibleCount = Array.isArray(visibleResponseMessageItems)
                              ? visibleResponseMessageItems.length
                              : 0;
                            return visibleCount === totalCount
                              ? String(totalCount)
                              : `${visibleCount}/${totalCount}`;
                          })()}
                        </Text>
                      </div>
                      <div className='flex-1 min-h-0 overflow-auto rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)]'>
                        {(() => {
                          const items = visibleResponseMessageItems;
                          if (!items || items.length === 0) {
                            return (
                              <div className='p-3'>
                                <Text type='tertiary'>
                                  {shouldFilterBySearch
                                    ? t('无匹配结果')
                                    : t('该响应没有消息内容')}
                                </Text>
                              </div>
                            );
                          }

                          return items.map((item) => {
                            const message = item?.message;
                            if (!message) {
                              return null;
                            }

                            const isSelected =
                              selectedMessageMeta?.source === item.source &&
                              selectedMessageMeta?.messageIndex === item.messageIndex;
                            const summary = getMessageCompactSummary(message);

                            return (
                              <button
                                key={`response-compact-${item.messageIndex}`}
                                type='button'
                                className={`relative w-full flex items-center gap-2 px-3 h-10 text-left border-b border-[var(--semi-color-border)] last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--semi-color-primary)] focus-visible:ring-inset ${isSelected ? 'bg-[var(--semi-color-fill-1)] border-l-2 border-l-[var(--semi-color-primary)]' : 'hover:bg-[var(--semi-color-fill-0)] border-l-2 border-l-transparent'}`}
                                onClick={() =>
                                  openMessageDetail(item.source, item.messageIndex)
                                }
                              >
                                {isSelected ? (
                                  <span
                                    aria-hidden
                                    className='absolute left-0 top-0 bottom-0 w-1 bg-[var(--semi-color-primary)]'
                                  />
                                ) : null}
                                <div className='w-20 flex-none overflow-hidden'>
                                  <Tag type='ghost' color='blue' className='whitespace-nowrap'>
                                    {message.role}
                                  </Tag>
                                </div>
                                <div className='flex-1 min-w-0 truncate text-sm'>
                                  {summary ? (
                                    renderHighlightedText(summary, effectiveSearchQuery)
                                  ) : (
                                    <span className='text-[var(--semi-color-text-2)]'>
                                      {t('暂无内容')}
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>

                  {!isMobile ? (
                    <div className='flex flex-col min-h-0 flex-1 min-w-0 border-l border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)]'>
                      <div className='shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--semi-color-border)]'>
                        <div className='flex items-center gap-2 min-w-0'>
                          {selectedMessage ? (
                            <div className='flex items-center gap-2 min-w-0 overflow-hidden'>
                              <Tag
                                type='ghost'
                                color={selectedMessageSourceColor}
                                className='whitespace-nowrap'
                              >
                                {selectedMessagePositionLabel}
                              </Tag>
                              <Tag type='ghost' color='grey' className='whitespace-nowrap'>
                                {selectedMessage.role}
                              </Tag>
                            </div>
                          ) : (
                            <Text type='tertiary'>{t('请选择一条消息')}</Text>
                          )}
                        </div>
                        {selectedMessage ? (
                          <div className='flex items-center gap-0'>
                            <Tooltip content={t('复制全文')}>
                              <Button
                                size='small'
                                theme='borderless'
                                icon={<IconCopy />}
                                aria-label={t('复制全文')}
                                onClick={() =>
                                  handleCopyMessage(selectedMessage, 'full')
                                }
                              />
                            </Tooltip>
                            <Dropdown
                              position='bottomRight'
                              render={
                                <Dropdown.Menu>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'full')
                                    }
                                  >
                                    {t('复制全文')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'plain')
                                    }
                                  >
                                    {t('仅复制文本')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'tools')
                                    }
                                  >
                                    {t('仅复制工具')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'markdown')
                                    }
                                  >
                                    {t('复制为 Markdown')}
                                  </Dropdown.Item>
                                </Dropdown.Menu>
                              }
                            >
                              <Button
                                size='small'
                                theme='borderless'
                                icon={<IconChevronDown />}
                                aria-label={t('更多复制选项')}
                              />
                            </Dropdown>
                          </div>
                        ) : null}
                      </div>

                      <div
                        className='flex-1 min-h-0 overflow-auto p-3'
                        data-usage-scroll-container='detail'
                      >
                        {selectedMessage ? (
                          <MessageContent
                            message={selectedMessage}
                            t={t}
                            highlightQuery={effectiveSearchQuery}
                            source={selectedMessageMeta.source}
                            messageIndex={selectedMessageMeta.messageIndex}
                            registerSegmentRef={registerSegmentRef}
                            activeHitUid={activeHitUid}
                            hitPulseNonce={hitPulseNonce}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {isMobile ? (
                    <div
                      className={`absolute inset-0 z-20 flex flex-col min-h-0 bg-[var(--semi-color-bg-1)] transition-transform duration-200 ease-out ${messageDetailOpen ? 'translate-x-0 pointer-events-auto' : 'translate-x-full pointer-events-none'}`}
                    >
                      <div className='shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--semi-color-border)]'>
                        <Space align='center' spacing={8}>
                          <Tooltip content={t('关闭')}>
                            <Button
                              size='small'
                              theme='borderless'
                              icon={<IconClose />}
                              aria-label={t('关闭')}
                              onClick={closeMessageDetail}
                            />
                          </Tooltip>
                          {selectedMessage ? (
                            <div className='flex items-center gap-2 min-w-0 overflow-hidden'>
                              <Tag
                                type='ghost'
                                color={selectedMessageSourceColor}
                                className='whitespace-nowrap'
                              >
                                {selectedMessagePositionLabel}
                              </Tag>
                              <Tag type='ghost' color='grey' className='whitespace-nowrap'>
                                {selectedMessage.role}
                              </Tag>
                            </div>
                          ) : (
                            <Text type='tertiary'>{t('请选择一条消息')}</Text>
                          )}
                        </Space>
                        {selectedMessage ? (
                          <div className='flex items-center gap-0'>
                            <Tooltip content={t('复制全文')}>
                              <Button
                                size='small'
                                theme='borderless'
                                icon={<IconCopy />}
                                aria-label={t('复制全文')}
                                onClick={() =>
                                  handleCopyMessage(selectedMessage, 'full')
                                }
                              />
                            </Tooltip>
                            <Dropdown
                              position='bottomRight'
                              render={
                                <Dropdown.Menu>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'full')
                                    }
                                  >
                                    {t('复制全文')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'plain')
                                    }
                                  >
                                    {t('仅复制文本')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'tools')
                                    }
                                  >
                                    {t('仅复制工具')}
                                  </Dropdown.Item>
                                  <Dropdown.Item
                                    onClick={() =>
                                      handleCopyMessage(selectedMessage, 'markdown')
                                    }
                                  >
                                    {t('复制为 Markdown')}
                                  </Dropdown.Item>
                                </Dropdown.Menu>
                              }
                            >
                              <Button
                                size='small'
                                theme='borderless'
                                icon={<IconChevronDown />}
                                aria-label={t('更多复制选项')}
                              />
                            </Dropdown>
                          </div>
                        ) : null}
                      </div>

                      <div
                        className='flex-1 min-h-0 overflow-auto p-3'
                        data-usage-scroll-container='detail'
                      >
                        {selectedMessage ? (
                          <MessageContent
                            message={selectedMessage}
                            t={t}
                            highlightQuery={effectiveSearchQuery}
                            source={selectedMessageMeta.source}
                            messageIndex={selectedMessageMeta.messageIndex}
                            registerSegmentRef={registerSegmentRef}
                            activeHitUid={activeHitUid}
                            hitPulseNonce={hitPulseNonce}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {activeTab === 'metrics' && (
              <Descriptions
                size='small'
                style={{ width: '100%' }}
                data={(() => {
                  const rows = [];

                  const promptTokens =
                    log?.prompt_tokens !== undefined
                      ? log.prompt_tokens
                      : responseUsage?.prompt_tokens;
                  const completionTokens =
                    log?.completion_tokens !== undefined
                      ? log.completion_tokens
                      : responseUsage?.completion_tokens;

                  if (responseJson?.model) {
                    rows.push({
                      key: t('实际模型'),
                      value: responseJson.model,
                    });
                  }
                  if (promptTokens !== undefined) {
                    rows.push({ key: t('提示Tokens'), value: promptTokens });
                  }
                  if (completionTokens !== undefined) {
                    rows.push({
                      key: t('补全Tokens'),
                      value: completionTokens,
                    });
                  }
                  if (responseUsage?.total_tokens !== undefined) {
                    rows.push({
                      key: t('总Tokens'),
                      value: responseUsage.total_tokens,
                    });
                  }
                  if (log?.quota !== undefined) {
                    rows.push({ key: t('消耗额度'), value: log.quota });
                  }
                  if (log?.use_time !== undefined) {
                    rows.push({ key: t('耗时'), value: `${log.use_time}s` });
                  }
                  if (other?.frt !== undefined) {
                    rows.push({ key: t('首包时延'), value: `${other.frt}s` });
                  }
                  if (hasStreamData) {
                    rows.push({ key: t('流式'), value: t('是') });
                  }

                  if (rows.length === 0) {
                    rows.push({ key: t('状态'), value: t('暂无数据') });
                  }
                  return rows;
                })()}
              />
            )}

            {activeTab === 'tools' && (
              <Space vertical align='start' style={{ width: '100%', gap: 12 }}>
                {(() => {
                  const invocations = filteredToolInvocations;
                  if (!invocations || invocations.length === 0) {
                    return (
                      <Text type='tertiary'>
                        {shouldFilterBySearch ||
                        filterToolName ||
                        filterCallId ||
                        filterToolStatus !== 'all'
                          ? t('无匹配结果')
                          : t('未发现工具调用')}
                      </Text>
                    );
                  }

                  return invocations.map((invocation, index) => {
                    const hasCall = Boolean(invocation.call);
                    const results = Array.isArray(invocation.results)
                      ? invocation.results
                      : [];

                    const status = !hasCall
                      ? { label: t('仅结果'), color: 'orange' }
                      : results.length > 0
                        ? { label: t('已完成'), color: 'green' }
                        : { label: t('缺少结果'), color: 'yellow' };

                    return (
                      <div
                        key={`tool-invocation-${invocation.id || invocation.name || index}`}
                        className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-bg-1)] p-3 w-full'
                      >
                        <Space align='center' wrap spacing={8}>
                          <Text strong>{t('工具')}</Text>
                          {invocation.name ? (
                            <Tag type='ghost' color='blue'>
                              {invocation.name}
                            </Tag>
                          ) : null}
                          {invocation.id ? (
                            <Tag type='ghost' color='cyan'>
                              {t('ID')}: {invocation.id}
                            </Tag>
                          ) : null}
                          <Tag type='ghost' color={status.color}>
                            {status.label}
                          </Tag>
                          <Button
                            size='small'
                            theme='borderless'
                            onClick={() => {
                              const target = invocation.call || results[0];
                              if (!target) {
                                return;
                              }

                              const targetUid = makeSegmentUid(
                                target.source,
                                target.messageIndex,
                                target.segmentIndex,
                              );

                              setOnlyMatches(false);
                              setActiveTab('messages');
                              setActiveHitUid(targetUid);
                              setHitPulseNonce((n) => n + 1);
                              setPendingJumpUid(targetUid);
                            }}
                          >
                            {t('查看上下文')}
                          </Button>
                        </Space>

                        <div className='mt-3 pl-4 border-l border-[var(--semi-color-border)]'>
                          {hasCall ? (
                            <div className='relative'>
                              <div className='absolute -left-[11px] top-3 h-2 w-2 rounded-full bg-[var(--semi-color-primary)]' />
                              <MessageSegmentView
                                segment={invocation.call.segment}
                                t={t}
                                highlightQuery={effectiveSearchQuery}
                                segmentUid={makeSegmentUid(
                                  invocation.call.source,
                                  invocation.call.messageIndex,
                                  invocation.call.segmentIndex,
                                )}
                                registerSegmentRef={registerSegmentRef}
                                activeHitUid={activeHitUid}
                                hitPulseNonce={hitPulseNonce}
                              />
                            </div>
                          ) : (
                            <Text type='tertiary'>
                              {t('未找到对应的工具调用')}
                            </Text>
                          )}

                          {results.length > 0 ? (
                            <div className='mt-2 flex flex-col gap-2'>
                              {results.map((item) => {
                                const segmentUid = makeSegmentUid(
                                  item.source,
                                  item.messageIndex,
                                  item.segmentIndex,
                                );
                                return (
                                  <div key={segmentUid} className='relative'>
                                    <div className='absolute -left-[11px] top-3 h-2 w-2 rounded-full bg-[var(--semi-color-success)]' />
                                    <MessageSegmentView
                                      segment={item.segment}
                                      t={t}
                                      highlightQuery={effectiveSearchQuery}
                                      segmentUid={segmentUid}
                                      registerSegmentRef={registerSegmentRef}
                                      activeHitUid={activeHitUid}
                                      hitPulseNonce={hitPulseNonce}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  });
                })()}
              </Space>
            )}

            {activeTab === 'stream' && (
              <Space vertical align='start' style={{ width: '100%', gap: 12 }}>
                {Array.isArray(streamObjects) && streamObjects.length > 0 ? (
                  <div
                    id='usage-seg-stream'
                    data-usage-seg='stream'
                    ref={registerSegmentRef('stream')}
                    className='w-full'
                    style={
                      activeHitUid === 'stream'
                        ? {
                            animation: `${hitPulseNonce % 2 === 0 ? 'usageHitPulseA' : 'usageHitPulseB'} 900ms ease-out 1`,
                            borderRadius: 8,
                          }
                        : undefined
                    }
                  >
                    <CollapsibleText
                      text={streamObjects
                        .map((obj) => JSON.stringify(obj, null, 2))
                        .join('\n\n')}
                      t={t}
                      isCode
                      maxLines={12}
                      highlightQuery={effectiveSearchQuery}
                    />
                  </div>
                ) : (
                  <Text type='tertiary'>{t('暂无流式数据')}</Text>
                )}
              </Space>
            )}
            </div>
          </>
        ) : (
          <div
            ref={mainScrollRef}
            className='flex-1 min-h-0 overflow-auto w-full'
            data-usage-scroll-container='main'
          >
            <RawView
              t={t}
              requestRaw={requestRaw}
              responseRaw={responseRaw}
              responseJson={responseJson}
              streamObjects={streamObjects}
            />
          </div>
        )}
      </Space>
    </SideSheet>
  );
};

export default UsageLogDetailDrawer;
