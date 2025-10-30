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

import React, { useCallback, useMemo, useState } from 'react';
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
  Tooltip,
  Toast,
} from '@douyinfe/semi-ui';
import { IconClose, IconCopy } from '@douyinfe/semi-icons';

const { Title, Text, Paragraph } = Typography;

const safeParseJson = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
};

const decodeUnicodeEscapes = (raw) => {
  if (typeof raw !== 'string') {
    return raw;
  }
  if (!/(\\u[0-9a-fA-F]{4})|(\\n)|(\\r)|(\\t)/.test(raw)) {
    return raw;
  }
  let output = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16)),
  );
  output = output.replace(/\\n/g, '\n');
  output = output.replace(/\\r/g, '\r');
  output = output.replace(/\\t/g, '\t');
  return output;
};

const formatJsonString = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  const parsed = safeParseJson(raw);
  if (!parsed) {
    return raw.trim();
  }
  try {
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    return raw.trim();
  }
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
    id: result.tool_use_id || result.toolUseId || result.id || result.tool_call_id,
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
    .filter((segment) => segment.type === 'text' || segment.type === 'reasoning')
    .map((segment) => segment.value)
    .join('\n');
};

const copyToClipboard = async (text) => {
  if (!text || !text.trim()) {
    return false;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);

    const selection = document.getSelection();
    const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    textarea.select();
    const succeeded = document.execCommand('copy');

    document.body.removeChild(textarea);

    if (selectedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }

    return succeeded;
  } catch (error) {
    return false;
  }
};

const getSegmentCopyText = (segment, t) => {
  if (!segment) {
    return '';
  }

  const value = typeof segment.value === 'string' ? segment.value : String(segment.value ?? '');

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
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
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
    addReasoningSegment(segments, node.text ?? node.reasoning ?? node.thinking ?? node.value);
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
        const existing =
          toolCalls[targetIndex] || {
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
              (block.partialJson || '') + (delta.partial_json ?? delta.partialJson ?? '');
            break;
          case 'tool_use_delta':
            block.partialJson = (block.partialJson || '') + (delta.arguments || '');
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
    const withUsage = [...streamObjects].reverse().find((obj) => obj.usage);
    return withUsage?.usage ?? null;
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
        source?.content ??
          source?.text ??
          source?.delta?.content ??
          source,
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

  if (responseObject?.message) {
    pushMessage(responseObject.message, responseObject.message.role || 'assistant');
  }

  if (responseObject?.result) {
    pushMessage(responseObject.result, responseObject.result.role || 'assistant');
  }

  if (Array.isArray(responseObject?.messages)) {
    responseObject.messages.forEach((item) => {
      pushMessage(item, item?.role || 'assistant');
    });
  }

  if (responseObject?.completion) {
    pushMessage(
      { role: responseObject.role || 'assistant', content: responseObject.completion },
      responseObject.role || 'assistant',
    );
  }

  if (responseObject?.reply) {
    pushMessage(
      { role: responseObject.role || 'assistant', content: responseObject.reply },
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
  pushIfPresent(t('响应格式'), requestObject.response_format);
  if (requestObject.tools) {
    pushIfPresent(t('工具调用'), JSON.stringify(requestObject.tools));
  }
  if (requestObject.user) {
    pushIfPresent(t('用户'), requestObject.user);
  }
  return params;
};

const CollapsibleText = ({ text, t, isCode = false, maxLines = 6 }) => {
  const [expanded, setExpanded] = useState(false);
  if (!text || text.trim() === '') {
    return <Text type='tertiary'>{t('暂无数据')}</Text>;
  }

  const lines = text.split('\n');
  const shouldTruncate = lines.length > maxLines || text.length > 600;
  const displayedText =
    shouldTruncate && !expanded ? lines.slice(0, maxLines).join('\n') : text;

  return (
    <div className='flex flex-col gap-2 w-full'>
      {isCode ? (
        <pre className='whitespace-pre-wrap break-all font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3'>
          {displayedText}
        </pre>
      ) : (
        <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
          {displayedText}
        </Paragraph>
      )}
      {shouldTruncate && (
        <Button
          size='small'
          type='tertiary'
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? t('收起') : t('展开')}
        </Button>
      )}
    </div>
  );
};

const MessageSegmentView = ({ segment, t }) => {
  if (!segment) {
    return null;
  }

  switch (segment.type) {
    case 'text':
      return <CollapsibleText text={segment.value} t={t} />;
    case 'reasoning':
      return (
        <div className='w-full flex flex-col gap-1'>
          <Text type='tertiary'>{t('思考过程')}</Text>
          <CollapsibleText text={segment.value} t={t} />
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
          </Space>
          <CollapsibleText text={segment.value} t={t} isCode />
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
          </Space>
          <CollapsibleText text={segment.value} t={t} isCode />
        </div>
      );
    case 'json':
      return (
        <div className='w-full flex flex-col gap-1'>
          {segment.label ? (
            <Text type='tertiary'>{t(segment.label)}</Text>
          ) : null}
          <CollapsibleText text={segment.value} t={t} isCode />
        </div>
      );
    default:
      return <CollapsibleText text={segment.value ?? ''} t={t} />;
  }
};

const MessageContent = ({ message, t }) => {
  if (!message) {
    return null;
  }
  const segments = Array.isArray(message.segments)
    ? message.segments.filter(Boolean)
    : [];

  if (segments.length === 0) {
    if (message.text && message.text.trim()) {
      return <CollapsibleText text={message.text} t={t} />;
    }
    return <Text type='tertiary'>{t('暂无数据')}</Text>;
  }

  return (
    <Space vertical align='start' style={{ width: '100%' }} spacing={12}>
      {segments.map((segment, index) => (
        <MessageSegmentView key={`segment-${segment.type}-${index}`} segment={segment} t={t} />
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
            className='absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity'
            onClick={() => onCopyMessage && onCopyMessage(message)}
          />
        </Tooltip>
      </div>
    ));
  };

  return (
    <Space vertical align='start' style={{ width: '100%' }}>
      <Title heading={4}>{t('请求参数')}</Title>
      <Descriptions
        data={buildRequestParams(requestJson, t)}
        size='small'
        style={{ width: '100%' }}
        emptyContent={t('无请求参数')}
      />

      <Divider margin='12px 0' />

      <Title heading={4}>{t('请求消息')}</Title>
      <Space
        vertical
        align='start'
        style={{ width: '100%', gap: 12 }}
      >
        {renderMessageList(
          requestMessages,
          t('该请求没有消息内容'),
          'request-msg',
          'purple',
          'rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2 w-full',
        )}
      </Space>

      <Divider margin='12px 0' />

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

      <Divider margin='12px 0' />

      <Title heading={4}>{t('响应消息')}</Title>
      <Space
        vertical
        align='start'
        style={{ width: '100%', gap: 12 }}
      >
        {renderMessageList(
          responseMessages,
          t('该响应没有消息内容'),
          'response-msg',
          'blue',
          'rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-1)] px-3 py-2 w-full',
        )}
      </Space>
    </Space>
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
  const requestRaw = log?.detail?.request_body || '';
  const responseRaw = log?.detail?.response_body || '';

  const requestJson = useMemo(() => safeParseJson(requestRaw), [requestRaw]);
  const responseJson = useMemo(() => safeParseJson(responseRaw), [responseRaw]);
  const streamObjects = useMemo(
    () => (!responseJson ? splitStreamingResponse(responseRaw) : []),
    [responseJson, responseRaw],
  );

  const requestMessages = useMemo(
    () => collectRequestMessages(requestJson),
    [requestJson],
  );
  const responseMessages = useMemo(
    () => collectResponseMessages(responseJson, streamObjects),
    [responseJson, streamObjects],
  );
  const responseUsage = useMemo(
    () => collectResponseUsage(responseJson, streamObjects),
    [responseJson, streamObjects],
  );

  const handleCopyMessage = useCallback(
    async (message) => {
      const copyText = buildMessageCopyText(message, t);
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

  const formattedView = useMemo(
    () =>
      buildFormattedView({
        t,
        requestJson,
        responseJson,
        requestMessages,
        responseMessages,
        responseUsage,
        onCopyMessage: handleCopyMessage,
      }),
    [
      t,
      requestJson,
      responseJson,
      requestMessages,
      responseMessages,
      responseUsage,
      handleCopyMessage,
    ],
  );

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

  return (
    <SideSheet
      placement='right'
      visible={visible}
      onCancel={onClose}
      width={520}
      maskClosable
      title={t('请求详情')}
      className='usage-log-detail-drawer'
      closeIcon={
        <Button
          className='semi-button-tertiary semi-button-size-small semi-button-borderless'
          type='button'
          icon={<IconClose />}
          onClick={onClose}
        />
      }
      bodyStyle={{ padding: 24, height: '100%', overflow: 'auto' }}
    >
      <Space vertical align='start' style={{ width: '100%', gap: 16 }}>
        <RadioGroup
          type='button'
          buttonSize='small'
          value={viewMode}
          onChange={handleModeChange}
        >
          <Radio value='formatted'>{t('格式化视图')}</Radio>
          <Radio value='raw'>{t('原始数据')}</Radio>
        </RadioGroup>

        {viewMode === 'formatted' ? (
          formattedView
        ) : (
          <Space vertical align='start' style={{ width: '100%', gap: 16 }}>
            <div style={{ width: '100%' }}>
              <Title heading={4}>{t('请求体')}</Title>
              <pre className='whitespace-pre-wrap break-all font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3'>
                {formatJsonString(requestRaw) || t('暂无数据')}
              </pre>
            </div>
            <div style={{ width: '100%' }}>
              <Title heading={4}>{t('响应体')}</Title>
              <pre className='whitespace-pre-wrap break-all font-mono text-xs leading-5 bg-[var(--semi-color-fill-0)] border border-[var(--semi-color-border)] rounded-md p-3'>
                {(() => {
                  if (responseJson) {
                    return formatJsonString(responseRaw);
                  }
                  if (streamObjects.length > 0) {
                    return streamObjects
                      .map((obj) => JSON.stringify(obj, null, 2))
                      .join('\n\n');
                  }
                  return responseRaw ? responseRaw.trim() : t('暂无数据');
                })()}
              </pre>
            </div>
          </Space>
        )}
      </Space>
    </SideSheet>
  );
};

export default UsageLogDetailDrawer;
