import { sanitizeFilename } from '../../../src/telegram/media.js';

describe('Telegram media instruction-file names', () => {
  it.each([
    ['CLAUDE.md', 'incoming_CLAUDE.md.txt'],
    ['AGENTS.md', 'incoming_AGENTS.md.txt'],
    ['claude.local.md', 'incoming_claude.local.md.txt'],
    ['Agents.Local.md', 'incoming_Agents.Local.md.txt'],
    ['Settings.json', 'incoming_Settings.json.txt'],
    ['settings.local.json', 'incoming_settings.local.json.txt'],
    ['rules.mdc', 'incoming_rules.mdc.txt'],
  ])('neutralizes %s', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it.each(['report.md', 'PMinaBox.dmg'])('preserves ordinary file %s', (input) => {
    expect(sanitizeFilename(input)).toBe(input);
  });
});
