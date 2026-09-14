export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 300_000;

export function normalizeKey(value) {
  const key = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(key) || key.includes("..")) {
    throw new TypeError("key must be a safe 1-256 character identifier");
  }
  return key;
}

export function normalizeTtlMs(value) {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
    throw new RangeError(`ttl_ms must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}`);
  }
  return value;
}

export function leaseIsLive(lease, nowMs = Date.now()) {
  return lease != null && Number.isSafeInteger(lease.expires_at) && lease.expires_at > nowMs;
}

export function normalizeExpectedVersion(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("expected_version must be null or a non-negative integer");
  return value;
}
