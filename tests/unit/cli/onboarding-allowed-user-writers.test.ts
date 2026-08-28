import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { normalizeAllowedUser } from '../../../src/daemon/allowed-user.js';

function evaluateAllowedUserWriter(relativePath: string): string {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf-8');
  const expression = source.match(/const allowedUser = ([^;]+);/)?.[1];
  if (!expression) throw new Error(`No allowedUser writer found in ${relativePath}`);

  const user = { fromId: 555111222, username: 'operator' };
  return Function('user', `return ${expression}`)(user) as string;
}

describe('onboarding ALLOWED_USER writers', () => {
  for (const writer of ['src/cli/detect-chat-id.ts', 'src/cli/bot.ts']) {
    it(`${writer} writes the numeric Telegram user id when username is present`, () => {
      const allowedUser = evaluateAllowedUserWriter(writer);

      expect(allowedUser).toBe('555111222');
      expect(normalizeAllowedUser(allowedUser)).not.toBeNull();
    });
  }
});
