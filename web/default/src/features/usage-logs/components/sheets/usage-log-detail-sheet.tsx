import { useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, Download, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  formatLogQuota,
  formatTimestampToDate,
  formatUseTime,
} from '@/lib/format'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { UsageLog } from '../../data/schema'
import {
  DETAIL_PREVIEW_BYTES,
  DETAIL_TRUNCATE_BYTES,
  extractDetailMessages,
  extractDetailTools,
  extractStreamChunks,
  hasSavedDetail,
  parsePayload,
  type DetailMessage,
  type DetailStreamChunk,
  type DetailToolEntry,
  type ParsedPayload,
} from '../../lib/detail'
import { parseLogOther } from '../../lib/format'
import { getLogTypeConfig } from '../../lib/utils'

interface UsageLogDetailSheetProps {
  log: UsageLog | null
  open: boolean
  isAdmin: boolean
  onOpenChange: (open: boolean) => void
}

type DetailTab = 'overview' | 'raw' | 'messages' | 'tools' | 'metrics' | 'stream'
type CopiedKey = 'request' | 'response' | 'all' | null

interface DetailItem {
  label: string
  value: string | number | null | undefined
}

interface SearchResult {
  count: number
  firstIndex: number
}

function formatValue(value: DetailItem['value']): string {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function hasDetailValue(item: DetailItem): boolean {
  return item.value !== null && item.value !== undefined && item.value !== ''
}

function getSearchResult(content: string, query: string): SearchResult {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return { count: 0, firstIndex: -1 }

  const normalizedContent = content.toLowerCase()
  let count = 0
  let index = normalizedContent.indexOf(normalizedQuery)
  const firstIndex = index

  while (index !== -1) {
    count += 1
    index = normalizedContent.indexOf(normalizedQuery, index + normalizedQuery.length)
  }

  return { count, firstIndex }
}

function highlightSearchMatch(content: string, query: string): ReactNode {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return content

  const index = content.toLowerCase().indexOf(normalizedQuery.toLowerCase())
  if (index === -1) return content

  return (
    <>
      {content.slice(0, index)}
      <mark className='rounded bg-yellow-200 px-0.5 text-yellow-950 dark:bg-yellow-500/30 dark:text-yellow-100'>
        {content.slice(index, index + normalizedQuery.length)}
      </mark>
      {content.slice(index + normalizedQuery.length)}
    </>
  )
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function safeFilename(value: string | null | undefined): string {
  return (value || 'usage-log').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)
}

function DetailGrid({ items }: { items: DetailItem[] }) {
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
      {items.map((item) => (
        <div key={item.label} className='bg-card/60 rounded-lg border p-3'>
          <div className='text-muted-foreground text-xs'>{item.label}</div>
          <div className='mt-1 text-sm font-medium break-words'>
            {formatValue(item.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

function PayloadPanel({
  title,
  payload,
  showRaw,
  copied,
  downloadName,
  onCopy,
}: {
  title: string
  payload: ParsedPayload
  showRaw: boolean
  copied: boolean
  downloadName: string
  onCopy: () => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const content = showRaw ? payload.preview : payload.formatted
  const isEmpty = payload.raw.length === 0
  const searchResult = useMemo(
    () => getSearchResult(content, search),
    [content, search]
  )

  const handleDownload = () => {
    if (isEmpty) return
    downloadText(downloadName, payload.raw)
  }

  return (
    <section className='bg-card/60 flex min-h-0 flex-col rounded-lg border'>
      <div className='space-y-3 border-b p-3'>
        <div className='flex items-center justify-between gap-2'>
          <div>
            <h3 className='text-sm font-semibold'>{title}</h3>
            {payload.isTruncated && (
              <p className='text-muted-foreground mt-1 text-xs'>
                {t(
                  'Large content truncated for display. Copy still uses the full content.'
                )}
              </p>
            )}
          </div>
          <div className='flex shrink-0 flex-wrap gap-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={isEmpty}
              onClick={handleDownload}
            >
              <Download className='size-3.5' />
              {t('Download')}
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={isEmpty}
              onClick={onCopy}
            >
              {copied ? (
                <Check className='size-3.5' />
              ) : (
                <Copy className='size-3.5' />
              )}
              {t('Copy')}
            </Button>
          </div>
        </div>
        <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
          <Input
            value={search}
            disabled={isEmpty}
            placeholder={t('Search current preview')}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className='text-muted-foreground shrink-0 text-xs'>
            {search.trim()
              ? t('{{count}} match(es)', { count: searchResult.count })
              : t('Search uses the displayed preview only')}
          </span>
        </div>
      </div>
      <ScrollArea className='min-h-[220px] flex-1'>
        <pre className='text-muted-foreground p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap'>
          {isEmpty
            ? t('No data in this section')
            : highlightSearchMatch(content, search)}
        </pre>
        <ScrollBar orientation='horizontal' />
      </ScrollArea>
    </section>
  )
}

function PayloadPanels({
  requestPayload,
  responsePayload,
  showRaw,
  copiedKey,
  downloadPrefix,
  onCopy,
}: {
  requestPayload: ParsedPayload
  responsePayload: ParsedPayload
  showRaw: boolean
  copiedKey: CopiedKey
  downloadPrefix: string
  onCopy: (key: Exclude<CopiedKey, null>, text: string) => void
}) {
  const { t } = useTranslation()

  return (
    <div className='grid min-h-0 gap-4 lg:grid-cols-2'>
      <PayloadPanel
        title={t('Request Body')}
        payload={requestPayload}
        showRaw={showRaw}
        copied={copiedKey === 'request'}
        downloadName={`${downloadPrefix}-request.json`}
        onCopy={() => onCopy('request', requestPayload.raw)}
      />
      <PayloadPanel
        title={t('Response Body')}
        payload={responsePayload}
        showRaw={showRaw}
        copied={copiedKey === 'response'}
        downloadName={`${downloadPrefix}-response.json`}
        onCopy={() => onCopy('response', responsePayload.raw)}
      />
    </div>
  )
}

function EmptyTabState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className='min-h-[260px] border-none'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <FileText className='size-6' />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function SectionCard({
  title,
  badge,
  children,
}: {
  title: string
  badge?: string
  children: ReactNode
}) {
  return (
    <section className='bg-card/60 min-w-0 rounded-lg border'>
      <div className='flex flex-wrap items-center justify-between gap-2 border-b p-3'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        {badge && <Badge variant='outline'>{badge}</Badge>}
      </div>
      <div className='p-3'>{children}</div>
    </section>
  )
}

function DetailPre({ value }: { value: string }) {
  return (
    <pre className='text-muted-foreground font-mono text-xs leading-relaxed break-words whitespace-pre-wrap'>
      {value}
    </pre>
  )
}

function MessagesPanel({ messages }: { messages: DetailMessage[] }) {
  const { t } = useTranslation()

  if (messages.length === 0) {
    return (
      <EmptyTabState
        title={t('No parsed messages')}
        description={t('No chat messages were found in the saved payloads.')}
      />
    )
  }

  return (
    <div className='space-y-3'>
      {messages.map((message) => (
        <SectionCard
          key={message.id}
          title={message.name ? `${message.role} · ${message.name}` : message.role}
          badge={t(message.source === 'request' ? 'Request' : 'Response')}
        >
          <DetailPre value={message.content} />
        </SectionCard>
      ))}
    </div>
  )
}

function ToolsPanel({ entries }: { entries: DetailToolEntry[] }) {
  const { t } = useTranslation()

  if (entries.length === 0) {
    return (
      <EmptyTabState
        title={t('No parsed tools')}
        description={t('No tool definitions or tool calls were found in the saved payloads.')}
      />
    )
  }

  return (
    <div className='space-y-3'>
      {entries.map((entry) => (
        <SectionCard
          key={entry.id}
          title={entry.name}
          badge={`${t(entry.source === 'request' ? 'Request' : 'Response')} · ${t(entry.kind)}`}
        >
          <DetailPre value={entry.content} />
        </SectionCard>
      ))}
    </div>
  )
}

function MetricsPanel({ items }: { items: DetailItem[] }) {
  const { t } = useTranslation()
  const visibleItems = items.filter(hasDetailValue)

  if (visibleItems.length === 0) {
    return (
      <EmptyTabState
        title={t('No metrics available')}
        description={t('No additional metrics were found for this record.')}
      />
    )
  }

  return <DetailGrid items={visibleItems} />
}

function StreamPanel({ chunks }: { chunks: DetailStreamChunk[] }) {
  const { t } = useTranslation()

  if (chunks.length === 0) {
    return (
      <EmptyTabState
        title={t('No stream chunks')}
        description={t('No SSE chunks were found in the saved response body.')}
      />
    )
  }

  return (
    <div className='space-y-3'>
      {chunks.map((chunk) => (
        <SectionCard
          key={chunk.id}
          title={`${t('Chunk')} #${chunk.index + 1}`}
          badge={[chunk.event, chunk.role, chunk.finishReason]
            .filter(Boolean)
            .join(' · ')}
        >
          <div className='space-y-3'>
            {chunk.content && <DetailPre value={chunk.content} />}
            <div className='rounded-md border bg-muted/30 p-3'>
              <DetailPre value={chunk.raw} />
            </div>
          </div>
        </SectionCard>
      ))}
    </div>
  )
}

function EmptyDetailState() {
  const { t } = useTranslation()

  return (
    <Empty className='min-h-[360px] border-none'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <FileText className='size-6' />
        </EmptyMedia>
        <EmptyTitle>{t('No saved request details')}</EmptyTitle>
        <EmptyDescription>
          {t('This record does not have saved request details.')}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function UsageLogDetailSheet({
  log,
  open,
  isAdmin,
  onOpenChange,
}: UsageLogDetailSheetProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [showRaw, setShowRaw] = useState(false)
  const [copiedKey, setCopiedKey] = useState<CopiedKey>(null)
  const { copyToClipboard } = useCopyToClipboard()

  const other = useMemo(() => parseLogOther(log?.other ?? ''), [log?.other])
  const requestPayload = useMemo(
    () =>
      parsePayload(
        log?.detail?.request_body,
        DETAIL_PREVIEW_BYTES,
        DETAIL_TRUNCATE_BYTES
      ),
    [log?.detail?.request_body]
  )
  const responsePayload = useMemo(
    () =>
      parsePayload(
        log?.detail?.response_body,
        DETAIL_PREVIEW_BYTES,
        DETAIL_TRUNCATE_BYTES
      ),
    [log?.detail?.response_body]
  )
  const messages = useMemo(
    () => extractDetailMessages(requestPayload, responsePayload),
    [requestPayload, responsePayload]
  )
  const tools = useMemo(
    () => extractDetailTools(requestPayload, responsePayload),
    [requestPayload, responsePayload]
  )
  const streamChunks = useMemo(
    () => extractStreamChunks(responsePayload),
    [responsePayload]
  )
  const typeConfig = getLogTypeConfig(log?.type ?? 0)
  const hasDetail = log ? hasSavedDetail(log) : false
  const tokenText = log
    ? `${log.prompt_tokens.toLocaleString()} / ${log.completion_tokens.toLocaleString()}`
    : '-'
  const downloadPrefix = `usage-log-${safeFilename(log?.request_id || String(log?.id ?? 'detail'))}`

  const overviewItems = useMemo<DetailItem[]>(
    () => [
      { label: t('Request ID'), value: log?.request_id },
      { label: t('Model'), value: log?.model_name },
      ...(isAdmin
        ? [
            {
              label: t('Channel'),
              value: log
                ? `#${log.channel}${log.channel_name ? ` ${log.channel_name}` : ''}`
                : null,
            },
          ]
        : []),
      { label: t('Token'), value: log?.token_name },
      { label: t('Group'), value: log?.group },
      { label: t('Time'), value: formatTimestampToDate(log?.created_at) },
      { label: t('Log Type'), value: t(typeConfig.label) },
      { label: t('Cost'), value: log ? formatLogQuota(log.quota) : null },
      { label: t('Tokens'), value: tokenText },
      { label: t('Latency'), value: log ? formatUseTime(log.use_time) : null },
      { label: t('Path'), value: other?.request_path },
      { label: t('Retry Chain'), value: other?.request_conversion?.join(' → ') },
      { label: t('Stream'), value: log?.is_stream ? t('Yes') : t('No') },
      {
        label: t('First response time'),
        value: other?.frt ? formatUseTime(other.frt) : null,
      },
      {
        label: t('Billing Source'),
        value: other?.billing_source ? t(other.billing_source) : null,
      },
    ],
    [isAdmin, log, other, t, tokenText, typeConfig.label]
  )
  const metricItems = useMemo<DetailItem[]>(
    () => [
      { label: t('Prompt Tokens'), value: log?.prompt_tokens.toLocaleString() },
      {
        label: t('Completion Tokens'),
        value: log?.completion_tokens.toLocaleString(),
      },
      {
        label: t('Total Tokens'),
        value: log
          ? (log.prompt_tokens + log.completion_tokens).toLocaleString()
          : null,
      },
      { label: t('Cost'), value: log ? formatLogQuota(log.quota) : null },
      { label: t('Latency'), value: log ? formatUseTime(log.use_time) : null },
      {
        label: t('First response time'),
        value: other?.frt ? formatUseTime(other.frt) : null,
      },
      {
        label: t('Billing Source'),
        value: other?.billing_source ? t(other.billing_source) : null,
      },
      {
        label: t('Billing Mode'),
        value: other?.billing_mode ? t(other.billing_mode) : null,
      },
      { label: t('Matched Tier'), value: other?.matched_tier },
      { label: t('Model Ratio'), value: other?.model_ratio },
      { label: t('Completion Ratio'), value: other?.completion_ratio },
      { label: t('Group Ratio'), value: other?.group_ratio },
      { label: t('User Group Ratio'), value: other?.user_group_ratio },
      { label: t('Cache Tokens'), value: other?.cache_tokens },
      { label: t('Cache Creation Tokens'), value: other?.cache_creation_tokens },
      {
        label: t('Audio Input Tokens'),
        value: other?.audio_input ?? other?.audio_input_token_count,
      },
      { label: t('Audio Output Tokens'), value: other?.audio_output },
      { label: t('Text Input Tokens'), value: other?.text_input },
      { label: t('Text Output Tokens'), value: other?.text_output },
      { label: t('Image Output Tokens'), value: other?.image_output },
      { label: t('Web Search Calls'), value: other?.web_search_call_count },
      { label: t('File Search Calls'), value: other?.file_search_call_count },
      {
        label: t('Image Generation Calls'),
        value: other?.image_generation_call ? t('Yes') : null,
      },
      { label: t('Request Path'), value: other?.request_path },
      { label: t('Retry Chain'), value: other?.request_conversion?.join(' → ') },
      { label: t('Upstream Model'), value: other?.upstream_model_name },
      ...(isAdmin
        ? [
            { label: t('IP'), value: log?.ip },
            { label: t('Stream Status'), value: other?.stream_status?.status },
            {
              label: t('Stream End Reason'),
              value: other?.stream_status?.end_reason,
            },
            {
              label: t('Stream Error Count'),
              value: other?.stream_status?.error_count,
            },
            {
              label: t('Stream End Error'),
              value: other?.stream_status?.end_error,
            },
            { label: t('Reject Reason'), value: other?.reject_reason },
          ]
        : []),
    ],
    [isAdmin, log, other, t]
  )

  const handleCopy = async (key: Exclude<CopiedKey, null>, text: string) => {
    const copied = await copyToClipboard(text)
    setCopiedKey(copied ? key : null)
  }

  const currentTabCopyText = useMemo(() => {
    switch (activeTab) {
      case 'messages':
        return messages
          .map(
            (message) =>
              `[${t(message.source === 'request' ? 'Request' : 'Response')}] ${message.role}\n${message.content}`
          )
          .join('\n\n')
      case 'tools':
        return tools
          .map(
            (entry) =>
              `[${t(entry.source === 'request' ? 'Request' : 'Response')}] ${t(entry.kind)} · ${entry.name}\n${entry.content}`
          )
          .join('\n\n')
      case 'metrics':
        return metricItems
          .filter(hasDetailValue)
          .map((item) => `${item.label}: ${formatValue(item.value)}`)
          .join('\n')
      case 'stream':
        return streamChunks
          .map(
            (chunk) =>
              `${t('Chunk')} #${chunk.index + 1}${chunk.event ? ` · ${chunk.event}` : ''}\n${chunk.content || chunk.raw}`
          )
          .join('\n\n')
      case 'overview':
        return overviewItems
          .map((item) => `${item.label}: ${formatValue(item.value)}`)
          .join('\n')
      case 'raw':
      default:
        return [
          `${t('Request Body')}\n${requestPayload.raw}`,
          `${t('Response Body')}\n${responsePayload.raw}`,
        ].join('\n\n')
    }
  }, [
    activeTab,
    messages,
    metricItems,
    overviewItems,
    requestPayload.raw,
    responsePayload.raw,
    streamChunks,
    t,
    tools,
  ])

  const copyCurrentTab = () => {
    handleCopy('all', currentTabCopyText)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setActiveTab('overview')
      setShowRaw(false)
      setCopiedKey(null)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className='w-screen max-w-none gap-0 p-0 sm:w-[min(960px,92vw)] sm:max-w-none'>
        <SheetHeader className='border-b px-4 py-4 sm:px-6'>
          <div className='flex flex-wrap items-start justify-between gap-3 pe-8'>
            <div className='min-w-0 space-y-2'>
              <SheetTitle className='flex flex-wrap items-center gap-2 text-lg'>
                {t('Request Details')}
                <Badge variant='outline'>{t(typeConfig.label)}</Badge>
              </SheetTitle>
              <SheetDescription className='flex flex-wrap gap-x-3 gap-y-1 text-xs'>
                <span>
                  {t('Request ID')}: {formatValue(log?.request_id)}
                </span>
                <span>
                  {t('Model')}: {formatValue(log?.model_name)}
                </span>
                <span>
                  {t('Token')}: {formatValue(log?.token_name)}
                </span>
              </SheetDescription>
            </div>
            <div className='flex shrink-0 flex-wrap gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={!hasDetail || currentTabCopyText.length === 0}
                onClick={copyCurrentTab}
              >
                {copiedKey === 'all' ? (
                  <Check className='size-3.5' />
                ) : (
                  <Copy className='size-3.5' />
                )}
                {t('Copy current tab')}
              </Button>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => setShowRaw((value) => !value)}
              >
                {showRaw ? t('Raw') : t('Formatted')}
              </Button>
            </div>
          </div>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as DetailTab)}
          className='min-h-0 flex-1 gap-0'
        >
          <div className='border-b px-4 py-2 sm:px-6'>
            <ScrollArea className='w-full'>
              <TabsList className='w-max justify-start'>
                <TabsTrigger value='overview'>{t('Overview')}</TabsTrigger>
                <TabsTrigger value='raw'>{t('Raw')}</TabsTrigger>
                <TabsTrigger value='messages'>{t('Messages')}</TabsTrigger>
                <TabsTrigger value='tools'>{t('Tools')}</TabsTrigger>
                <TabsTrigger value='metrics'>{t('Metrics')}</TabsTrigger>
                <TabsTrigger value='stream'>{t('Stream')}</TabsTrigger>
              </TabsList>
              <ScrollBar orientation='horizontal' />
            </ScrollArea>
          </div>

          <ScrollArea className='min-h-0 flex-1'>
            <div className='p-4 sm:p-6'>
              {!hasDetail ? (
                <EmptyDetailState />
              ) : (
                <>
                  <TabsContent value='overview' className='mt-0 space-y-4'>
                    <DetailGrid items={overviewItems} />
                  </TabsContent>

                  <TabsContent value='raw' className='mt-0'>
                    <PayloadPanels
                      requestPayload={requestPayload}
                      responsePayload={responsePayload}
                      showRaw={showRaw}
                      copiedKey={copiedKey}
                      downloadPrefix={downloadPrefix}
                      onCopy={handleCopy}
                    />
                  </TabsContent>

                  <TabsContent value='messages' className='mt-0'>
                    <MessagesPanel messages={messages} />
                  </TabsContent>

                  <TabsContent value='tools' className='mt-0'>
                    <ToolsPanel entries={tools} />
                  </TabsContent>

                  <TabsContent value='metrics' className='mt-0'>
                    <MetricsPanel items={metricItems} />
                  </TabsContent>

                  <TabsContent value='stream' className='mt-0'>
                    <StreamPanel chunks={streamChunks} />
                  </TabsContent>
                </>
              )}
            </div>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
