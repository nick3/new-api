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
import { describe, expect, test } from 'bun:test'

import {
  CHANNEL_FORM_DEFAULT_VALUES,
  transformChannelToFormDefaults,
  transformFormDataToCreatePayload,
} from '../lib/channel-form'
import { channelSchema } from '../types'

describe('channel request header passthrough setting', () => {
  test('serializes the enabled toggle into the channel setting payload', () => {
    const result = transformFormDataToCreatePayload({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'OpenAI',
      models: 'gpt-5',
      pass_through_header_enabled: true,
    })

    expect(JSON.parse(result.channel.setting ?? '{}')).toMatchObject({
      pass_through_header_enabled: true,
    })
  })

  test('restores the enabled toggle when editing an existing channel', () => {
    const channel = channelSchema.parse({
      id: 1,
      type: 1,
      key: '',
      status: 1,
      name: 'OpenAI',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      setting: JSON.stringify({ pass_through_header_enabled: true }),
    })

    expect(
      transformChannelToFormDefaults(channel).pass_through_header_enabled
    ).toBe(true)
  })
})
