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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest'

import { api } from '@/lib/api'

import { usageLogSchema } from '../../data/schema'
import { DETAIL_TRUNCATE_BYTES } from '../../lib/detail'
import { UsageLogDetailSheet } from '../sheets/usage-log-detail-sheet'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

const i18n = createInstance()
let client: QueryClient
const get = vi.mocked(api.get)
const log = usageLogSchema.parse({
  id: 1,
  detail_id: 987,
  has_detail: true,
  user_id: 7,
  created_at: 1,
  type: 2,
  content: '',
})

const originalGetAnimations = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'getAnimations'
)
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
})
afterAll(() => {
  if (originalGetAnimations) {
    Object.defineProperty(
      Element.prototype,
      'getAnimations',
      originalGetAnimations
    )
  } else {
    Reflect.deleteProperty(Element.prototype, 'getAnimations')
  }
})

beforeEach(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: {} } } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  get.mockReset()
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
})

function renderDetail(open = true, entry = log) {
  const onOpenChange = vi.fn()
  const wrapper = (props: { children: React.ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    </I18nextProvider>
  )
  return render(
    <UsageLogDetailSheet
      log={entry}
      open={open}
      isAdmin={false}
      onOpenChange={onOpenChange}
    />,
    { wrapper }
  )
}

test('opening a summary loads the stable detail ID and shows the saved messages', async () => {
  const pending = Promise.withResolvers<{ data: unknown }>()
  get.mockReturnValueOnce(pending.promise)
  const view = renderDetail(false)
  expect(get).not.toHaveBeenCalled()

  view.rerender(
    <UsageLogDetailSheet
      log={log}
      open
      isAdmin={false}
      onOpenChange={vi.fn()}
    />
  )
  expect(screen.getByRole('status')).toHaveTextContent('Loading...')
  expect(get).toHaveBeenCalledWith('/api/log/self/987/detail', {
    signal: expect.any(AbortSignal),
    disableDuplicate: true,
  })
  await act(async () =>
    pending.resolve({
      data: {
        success: true,
        data: {
          log_id: 987,
          request_body:
            '{"messages":[{"role":"user","content":"saved message"}]}',
          response_body: '',
        },
      },
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
  expect(
    await screen.findByRole('tabpanel', { name: 'Messages' })
  ).toHaveTextContent('saved message')
})

test('failed detail loading offers retry and an expired detail shows the empty state', async () => {
  get.mockResolvedValueOnce({ data: { success: false, message: 'failed' } })
  get.mockResolvedValueOnce({ data: { success: true, data: null } })
  renderDetail()
  expect(
    await screen.findByText('Failed to load request details')
  ).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByText(
      'Saved request details are missing or have expired.'
    )
  ).toBeVisible()
  expect(
    screen.queryByText('Failed to load request details')
  ).not.toBeInTheDocument()
})

test('closing the detail cancels its pending request and removes its query cache', async () => {
  get.mockReturnValueOnce(new Promise(() => {}))
  const view = renderDetail()
  const config = get.mock.calls[0][1]
  const signal = config?.signal as AbortSignal
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
  await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0))
})

test('downloading a truncated preview keeps the complete saved body', async () => {
  const body = JSON.stringify({ input: 'x'.repeat(DETAIL_TRUNCATE_BYTES + 1) })
  get.mockResolvedValueOnce({
    data: {
      success: true,
      data: {
        log_id: 987,
        request_body: body,
        response_body: '',
      },
    },
  })
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:detail')
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  renderDetail()
  await waitFor(() =>
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Raw' }))
  const panel = within(screen.getByRole('tabpanel', { name: 'Raw' }))
  expect(
    panel.getByText(
      'Large content truncated for display. Copy still uses the full content.'
    )
  ).toBeVisible()
  const download = panel
    .getAllByRole('button', { name: 'Download' })
    .find((button) => !button.hasAttribute('disabled'))
  expect(download).toBeDefined()
  if (!download) throw new Error('The saved request must be downloadable')
  fireEvent.click(download)
  const blob = createObjectURL.mock.calls[0][0]
  expect(await blob.text()).toBe(body)
})

test('legacy embedded details remain readable without an extra request', async () => {
  renderDetail(true, {
    ...log,
    detail_id: undefined,
    detail: {
      log_id: 987,
      request_body: '{"messages":[{"role":"user","content":"legacy message"}]}',
      response_body: '',
    },
  })
  fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
  expect(
    await screen.findByRole('tabpanel', { name: 'Messages' })
  ).toHaveTextContent('legacy message')
  expect(get).not.toHaveBeenCalled()
})
