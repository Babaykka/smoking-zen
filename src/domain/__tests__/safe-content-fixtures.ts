export const unicodeDashPunctuationFixtures = [
  '-', '֊', '־', '᐀', '᠆', '‐', '‑', '‒', '–', '—', '―', '⸗', '⸚', '⸺', '⸻', '⹀', '⹝', '〜', '〰', '゠',
  '︱', '︲', '﹘', '﹣', '－', '𐵮', '𐺭',
] as const;

export const unsafeSafeTextFixtures = [
  ...unicodeDashPunctuationFixtures.map((separator) => `password${separator}hunter2`),
  'pass\u200bword/hunter2',
  'pass\u200cword/hunter2',
  'pass\u200dword/hunter2',
  'pass\u2060word/hunter2',
  'pass\ufeffword/hunter2',
  '4111+1111+1111+1111',
  '4111–1111–1111–1111',
  '4111\u200b1111\u200c1111\u20601111',
  'ｐａｓｓｗｏｒｄ：ｈｕｎｔｅｒ２',
] as const;

export const safeSafeTextFixtures = [
  'Пароль хранится в Bitwarden; токены в рабочие заметки не копируются.',
  'Политика паролей и порядок плановой ротации.',
] as const;

export const unsafeSafeUrlFixtures = [
  ...unicodeDashPunctuationFixtures.map((separator) =>
    `https://vault.bitwarden.com/#/items/${encodeURIComponent(`password${separator}hunter2`)}`),
  'https://vault.bitwarden.com/?item=pass%E2%80%8Bword%2Fhunter2',
  'https://vault.bitwarden.com/#/items/pass%25E2%2580%258Bword%252Fhunter2',
  'https://vault.bitwarden.com/#/items/4111+1111+1111+1111',
  'https://vault.bitwarden.com/#/items/4111%E2%80%931111%E2%80%931111%E2%80%931111',
  'https://vault.bitwarden.com/#/items/4111%E2%80%8B1111%E2%80%8B1111%E2%80%8B1111',
  'https://vault.bitwarden.com/?4111.1111.1111.1111=x',
  'https://vault.bitwarden.com/items/4111:1111:1111:1111',
  'https://vault.bitwarden.com/#/items/ｐａｓｓｗｏｒｄ：ｈｕｎｔｅｒ２',
] as const;

export const safeSafeUrlFixtures = [
  'https://vault.bitwarden.com/#/items/example',
  'https://vault.bitwarden.com/#/vault/item/123e4567-e89b-12d3-a456-426614174000',
] as const;
