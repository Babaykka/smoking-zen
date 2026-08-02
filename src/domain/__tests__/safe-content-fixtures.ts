export const unicodeDashPunctuationFixtures = [
  '-', '֊', '־', '᐀', '᠆', '‐', '‑', '‒', '–', '—', '―', '⸗', '⸚', '⸺', '⸻', '⹀', '⹝', '〜', '〰', '゠',
  '︱', '︲', '﹘', '﹣', '－', '𐵮', '𐺭',
] as const;

// The scanner contract deliberately names every ECMAScript whitespace code point
// instead of delegating to runtime-specific \s / POSIX character classes.
export const canonicalSafeWhitespaceFixtures = [
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
  '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
] as const;

const unsafeWhitespaceTextFixtures = canonicalSafeWhitespaceFixtures.map((whitespace) =>
  whitespace === '\ufeff' ? `pass${whitespace}word/hunter2` : `password${whitespace}hunter2`);

const unsafeWhitespaceUrlFixtures = canonicalSafeWhitespaceFixtures.map((whitespace) => {
  const secret = whitespace === '\ufeff' ? `pass${whitespace}word/hunter2` : `password${whitespace}hunter2`;
  return `https://vault.bitwarden.com/?item=${encodeURIComponent(secret)}`;
});

const unsafeLiteralWhitespaceUrlFixtures = canonicalSafeWhitespaceFixtures.map((whitespace) =>
  `https://vault.bitwarden.com/#/items/example${whitespace}path`);

const unsafeBoundaryWhitespaceUrlFixtures = canonicalSafeWhitespaceFixtures.flatMap((whitespace) => [
  `${whitespace}https://vault.bitwarden.com/#/items/example`,
  `https://vault.bitwarden.com/#/items/example${whitespace}`,
]);

export const unsafeSafeTextFixtures = [
  ...unicodeDashPunctuationFixtures.map((separator) => `password${separator}hunter2`),
  ...unsafeWhitespaceTextFixtures,
  'pass\u200bword/hunter2',
  'pass\u200cword/hunter2',
  'pass\u200dword/hunter2',
  'pass\u2060word/hunter2',
  'pass\ufeffword/hunter2',
  '4111+1111+1111+1111',
  '4111–1111–1111–1111',
  '4111\u200b1111\u200c1111\u20601111',
  '4111\u16801111\u16801111\u16801111',
  'ｐａｓｓｗｏｒｄ：ｈｕｎｔｅｒ２',
] as const;

export const safeSafeTextFixtures = [
  'Пароль хранится в Bitwarden; токены в рабочие заметки не копируются.',
  'Политика паролей и порядок плановой ротации.',
] as const;

export const unsafeSafeUrlFixtures = [
  ...unicodeDashPunctuationFixtures.map((separator) =>
    `https://vault.bitwarden.com/#/items/${encodeURIComponent(`password${separator}hunter2`)}`),
  ...unsafeWhitespaceUrlFixtures,
  ...unsafeLiteralWhitespaceUrlFixtures,
  ...unsafeBoundaryWhitespaceUrlFixtures,
  'https://vault.bitwarden.com/?item=pass%E2%80%8Bword%2Fhunter2',
  'https://vault.bitwarden.com/#/items/pass%25E2%2580%258Bword%252Fhunter2',
  'https://vault.bitwarden.com/#/items/4111+1111+1111+1111',
  'https://vault.bitwarden.com/#/items/4111%E2%80%931111%E2%80%931111%E2%80%931111',
  'https://vault.bitwarden.com/#/items/4111%E2%80%8B1111%E2%80%8B1111%E2%80%8B1111',
  'https://vault.bitwarden.com/?4111.1111.1111.1111=x',
  'https://vault.bitwarden.com/items/4111:1111:1111:1111',
  'https://vault.bitwarden.com/#/items/ｐａｓｓｗｏｒｄ：ｈｕｎｔｅｒ２',
  'https://vault.bitwarden.com/?item=%C0%AF',
  'https://vault.bitwarden.com/?item=%',
  'https://vault.bitwarden.com/?item=%2',
  'https://vault.bitwarden.com/?item=%2525252525252541',
] as const;

export const safeSafeUrlFixtures = [
  'https://vault.bitwarden.com/#/items/example',
  'https://vault.bitwarden.com/#/vault/item/123e4567-e89b-12d3-a456-426614174000',
  'https://vault.bitwarden.com/#/items/example%20path',
  'https://vault.bitwarden.com/#/items/example%E1%9A%80path',
  'https://vault.bitwarden.com/?item=%25252525252541',
] as const;
