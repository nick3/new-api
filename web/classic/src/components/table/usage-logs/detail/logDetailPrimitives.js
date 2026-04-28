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

export const safeParseJson = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
};

export const decodeUnicodeEscapes = (raw) => {
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

export const formatJsonString = (raw) => {
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

export const splitStreamingResponse = (raw) => {
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

export const looksLikeStreamObject = (obj) => {
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

export const normaliseContent = (content) => {
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

export const toFormattedString = (value) => {
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

export const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
};

export const createSegment = (segment) => {
  if (!segment) {
    return null;
  }
  if (typeof segment.value === 'string' && segment.value.trim() === '') {
    return null;
  }
  return segment;
};

export const createTextSegment = (value) => {
  const text = normaliseContent(value);
  if (!text || text.trim() === '') {
    return null;
  }
  return { type: 'text', value: text };
};

export const createReasoningSegment = (value) => {
  const text = normaliseContent(value);
  if (!text || text.trim() === '') {
    return null;
  }
  return { type: 'reasoning', value: text };
};

export const createToolCallSegment = (tool) => {
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

export const createToolResultSegment = (result) => {
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

export const createJsonSegment = (label, value) => {
  const formatted = toFormattedString(value);
  if (!formatted) {
    return null;
  }
  return { type: 'json', label, value: formatted };
};

export const segmentsToPlainText = (segments) => {
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

export const getSegmentCopyText = (segment, t) => {
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

export const buildMessageCopyText = (message, t) => {
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

export const buildMessageCopyTextByFormat = (message, t, format) => {
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
