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

import React, { useMemo } from 'react';
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
} from '@douyinfe/semi-ui';
import { IconClose } from '@douyinfe/semi-icons';

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
  const objects = [];
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
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
    return content;
  }
  if (Array.isArray(content)) {
    return content
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
  }
  if (typeof content === 'object') {
    if (content.text) {
      return content.text;
    }
    if (content.value) {
      return content.value;
    }
    if (content.content) {
      return normaliseContent(content.content);
    }
    return JSON.stringify(content);
  }
  return String(content);
};

const collectRequestMessages = (requestObject) => {
  if (!requestObject) {
    return [];
  }
  const messages = [];
  if (Array.isArray(requestObject.messages)) {
    requestObject.messages.forEach((message) => {
      messages.push({
        role: message.role || 'user',
        content: normaliseContent(message.content ?? message.text),
      });
    });
  } else if (requestObject.input !== undefined) {
    const input = requestObject.input;
    if (Array.isArray(input)) {
      input.forEach((node) => {
        if (!node) {
          return;
        }
        messages.push({
          role: node.role || node.type || 'user',
          content: normaliseContent(node.content ?? node.text ?? node.input),
        });
      });
    } else if (typeof input === 'string') {
      messages.push({ role: 'user', content: input });
    } else if (typeof input === 'object') {
      messages.push({
        role: input.role || 'user',
        content: normaliseContent(input.content ?? input),
      });
    }
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
  const accumulateFromChoices = (choices = []) => {
    choices.forEach((choice) => {
      const role = choice.message?.role || choice.delta?.role || 'assistant';
      const content =
        normaliseContent(
          choice.message?.content ?? choice.delta?.content ?? choice.message,
        ) || '';
      if (content.trim()) {
        messages.push({ role, content });
      }
    });
  };

  if (responseObject?.choices) {
    accumulateFromChoices(responseObject.choices);
  } else if (Array.isArray(streamObjects) && streamObjects.length > 0) {
    const aggregated = streamObjects
      .map((obj) => normaliseContent(obj.choices?.[0]?.delta?.content))
      .join('')
      .trim();
    if (aggregated) {
      messages.push({ role: 'assistant', content: aggregated });
    }
  } else if (responseObject?.output) {
    const outputArray = Array.isArray(responseObject.output)
      ? responseObject.output
      : [responseObject.output];
    outputArray.forEach((item) => {
      if (!item) {
        return;
      }
      const role = item.role || 'assistant';
      const content = normaliseContent(item.content ?? item.item ?? item.text);
      if (content.trim()) {
        messages.push({ role, content });
      }
    });
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
      params.push({ key: label, value: String(value) });
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

const buildFormattedView = ({
  t,
  requestJson,
  responseJson,
  requestMessages,
  responseMessages,
  responseUsage,
}) => {
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
      <Space vertical align='start' style={{ width: '100%' }}>
        {requestMessages.length === 0 ? (
          <Text type='tertiary'>{t('该请求没有消息内容')}</Text>
        ) : (
          requestMessages.map((message, index) => (
            <div
              key={`request-msg-${index}`}
              className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-0)] px-3 py-2 w-full'
            >
              <Space align='start'>
                <Tag type='ghost' color='purple'>
                  {message.role}
                </Tag>
                <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {message.content}
                </Paragraph>
              </Space>
            </div>
          ))
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
      <Space vertical align='start' style={{ width: '100%' }}>
        {responseMessages.length === 0 ? (
          <Text type='tertiary'>{t('该响应没有消息内容')}</Text>
        ) : (
          responseMessages.map((message, index) => (
            <div
              key={`response-msg-${index}`}
              className='rounded-md border border-[var(--semi-color-border)] bg-[var(--semi-color-fill-1)] px-3 py-2 w-full'
            >
              <Space align='start'>
                <Tag type='ghost' color='blue'>
                  {message.role}
                </Tag>
                <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {message.content}
                </Paragraph>
              </Space>
            </div>
          ))
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

  const formattedView = useMemo(
    () =>
      buildFormattedView({
        t,
        requestJson,
        responseJson,
        requestMessages,
        responseMessages,
        responseUsage,
      }),
    [
      t,
      requestJson,
      responseJson,
      requestMessages,
      responseMessages,
      responseUsage,
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
