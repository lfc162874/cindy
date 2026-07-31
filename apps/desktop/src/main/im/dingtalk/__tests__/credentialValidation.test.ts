import { describe, expect, it } from 'vitest';

import { isSafeDingTalkId } from '../credentialValidation';

describe('DingTalk credential ID validation', () => {
  it.each(['ding_app-01', 'staff_1', 'A0_-'])('accepts safe ID %s', (value) => {
    expect(isSafeDingTalkId(value)).toBe(true);
  });

  it.each(['', 'staff/../../outside', String.raw`staff\\outside`, 'staff.name', 'staff name', 'staff@corp', '用户'])
    ('rejects unsafe ID %s', (value) => {
      expect(isSafeDingTalkId(value)).toBe(false);
    });
});
