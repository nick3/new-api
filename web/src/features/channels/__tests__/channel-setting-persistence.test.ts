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
import { describe, expect, test } from 'vitest'

import {
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
  transformFormDataToUpdatePayload,
} from '../lib/channel-form'
import { setHeaderPassthrough } from '../lib/header-passthrough'
import { channelSchema } from '../types'

describe('channel request header passthrough setting', () => {
  test('new channels save the upstream wildcard rule without the retired setting', () => {
    const result = transformFormDataToCreatePayload({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'OpenAI',
      models: 'gpt-5',
      header_override: '{"*":true}',
    })

    expect(JSON.parse(result.channel.header_override ?? '{}')).toEqual({
      '*': true,
    })
    expect(JSON.parse(result.channel.setting ?? '{}')).not.toHaveProperty(
      'pass_through_header_enabled'
    )
  })

  test.each([
    {
      name: 'enabled legacy setting with explicit overrides',
      legacyEnabled: true,
      headerOverride: '{"X-Custom":"value"}',
      expected: { '*': true, 'X-Custom': 'value' },
    },
    {
      name: 'enabled legacy setting without overrides',
      legacyEnabled: true,
      headerOverride: '',
      expected: { '*': true },
    },
    {
      name: 'disabled legacy setting',
      legacyEnabled: false,
      headerOverride: '{"X-Custom":"value"}',
      expected: { 'X-Custom': 'value' },
    },
    {
      name: 'both passthrough mechanisms enabled',
      legacyEnabled: true,
      headerOverride: '{"*":true,"X-Custom":"value"}',
      expected: { '*': true, 'X-Custom': 'value' },
    },
    {
      name: 'upstream wildcard with legacy setting disabled',
      legacyEnabled: false,
      headerOverride: '{"*":true}',
      expected: { '*': true },
    },
    {
      name: 'existing upstream-only configuration',
      legacyEnabled: undefined,
      headerOverride: '{"re:^x-":"","X-Custom":"value"}',
      expected: { 're:^x-': '', 'X-Custom': 'value' },
    },
  ])('editing $name saves and reloads through upstream rules', (testCase) => {
    const channel = channelSchema.parse({
      id: 1,
      type: 1,
      key: '',
      status: 1,
      name: 'OpenAI',
      models: 'gpt-5',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      setting: JSON.stringify({
        pass_through_header_enabled: testCase.legacyEnabled,
      }),
      header_override: testCase.headerOverride,
    })
    const defaults = transformChannelToFormDefaults(channel)
    const payload = transformFormDataToUpdatePayload(defaults, channel.id)

    expect(JSON.parse(payload.header_override ?? '{}')).toEqual(
      testCase.expected
    )
    expect(JSON.parse(payload.setting ?? '{}')).not.toHaveProperty(
      'pass_through_header_enabled'
    )
    const reloaded = transformChannelToFormDefaults(
      channelSchema.parse({
        ...channel,
        setting: payload.setting,
        header_override: payload.header_override,
      })
    )
    expect(JSON.parse(reloaded.header_override ?? '{}')).toEqual(
      testCase.expected
    )
  })

  test('disabling migrated passthrough removes the old flag and stays disabled after reload', () => {
    const channel = channelSchema.parse({
      id: 1,
      type: 1,
      key: '',
      status: 1,
      name: 'OpenAI',
      models: 'gpt-5',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      setting: '{"pass_through_header_enabled":true}',
    })
    const defaults = transformChannelToFormDefaults(channel)
    defaults.header_override = setHeaderPassthrough(
      defaults.header_override,
      false
    )
    const payload = transformFormDataToUpdatePayload(defaults, channel.id)

    expect(payload.header_override).toBe('')
    expect(JSON.parse(payload.setting ?? '{}')).not.toHaveProperty(
      'pass_through_header_enabled'
    )
    expect(
      transformChannelToFormDefaults(
        channelSchema.parse({
          ...channel,
          setting: payload.setting,
          header_override: payload.header_override,
        })
      ).header_override
    ).toBe('')
  })

  test('legacy passthrough preserves malformed override JSON and prevents saving until it is corrected', () => {
    const channel = channelSchema.parse({
      id: 1,
      type: 1,
      key: '',
      status: 1,
      name: 'OpenAI',
      models: 'gpt-5',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      setting: '{"pass_through_header_enabled":true}',
      header_override: '{"X-Custom":',
    })
    const defaults = transformChannelToFormDefaults(channel)

    expect(defaults.header_override).toBe(channel.header_override)
    const parsed = channelFormSchema.safeParse(defaults)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['header_override'] }),
        ])
      )
    }
  })
})
