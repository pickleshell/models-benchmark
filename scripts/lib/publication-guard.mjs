const SECRET_KEY = /(token|key|secret|access|refresh|password|credential)/i;
const MIN_SECRET_LENGTH = 12;

export function collectSecretLikeStrings(value, key = '') {
  if (typeof value === 'string') return SECRET_KEY.test(key) && value.length >= MIN_SECRET_LENGTH ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectSecretLikeStrings(entry, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, childValue]) => collectSecretLikeStrings(childValue, childKey));
}

export function assertNoKnownCredentialLeak(text, knownCredentials) {
  if (typeof text !== 'string' || !text || !knownCredentials?.size) return;
  for (const credential of knownCredentials) {
    if (credential && text.includes(credential)) {
      // Never include a matched value: fail rather than silently redact.
      throw new Error('refusing to publish model-controlled text containing a known credential');
    }
  }
}
