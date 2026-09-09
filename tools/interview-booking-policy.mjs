const POLICY_KEYS = Object.freeze([
  'actionableNotificationsOnly',
  'autoBookWhenSupported',
  'conflictPolicy',
  'externalSchedulerPolicy',
  'opportunityKind',
  'schemaVersion',
  'slotPreference',
  'timezone',
  'windowEnd',
  'windowStart',
]);

export const INTERVIEW_BOOKING_POLICY = Object.freeze({
  schemaVersion: 'v1',
  timezone: 'America/New_York',
  windowStart: '10:00',
  windowEnd: '19:00',
  conflictPolicy: 'avoid_existing_events',
  slotPreference: 'earliest_available',
  externalSchedulerPolicy: 'surface_link_when_unsupported',
  opportunityKind: 'engineering_job',
  autoBookWhenSupported: true,
  actionableNotificationsOnly: true,
});

const EXPECTED_POLICY = new Map(Object.entries(INTERVIEW_BOOKING_POLICY));
const EASTERN_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: INTERVIEW_BOOKING_POLICY.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactEnumerableDataKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== 'string')) return false;
  if (actual.some((key) => !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) return false;
  return JSON.stringify(actual.sort()) === JSON.stringify([...expectedKeys].sort());
}

export function validateInterviewBookingPolicy(policy) {
  if (!exactEnumerableDataKeys(policy, POLICY_KEYS)) {
    throw new Error('interview booking policy: malformed or unexpected fields');
  }
  for (const [key, expected] of EXPECTED_POLICY) {
    if (policy[key] !== expected) {
      throw new Error(`interview booking policy: ${key} does not match the approved v1 contract`);
    }
  }
  return true;
}

function parseInstant(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 64) {
    throw new Error(`${label}: expected bounded ISO timestamp string`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label}: invalid timestamp`);
  return millis;
}

function normalizeInterval(value, label) {
  if (!exactEnumerableDataKeys(value, ['end', 'start'])) {
    throw new Error(`${label}: expected exact start/end interval`);
  }
  const startMs = parseInstant(value.start, `${label}.start`);
  const endMs = parseInstant(value.end, `${label}.end`);
  if (endMs <= startMs) throw new Error(`${label}: end must be after start`);
  return Object.freeze({ start: value.start, end: value.end, startMs, endMs });
}

function easternParts(millis) {
  const parts = Object.fromEntries(
    EASTERN_FORMATTER.formatToParts(new Date(millis))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function clockMinutes(value, label) {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${label}: invalid clock time`);
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error(`${label}: invalid clock time`);
  return hour * 60 + minute;
}

export function isSlotWithinInterviewWindow(slot, policy = INTERVIEW_BOOKING_POLICY) {
  validateInterviewBookingPolicy(policy);
  const interval = normalizeInterval(slot, 'slot');
  const start = easternParts(interval.startMs);
  const end = easternParts(interval.endMs);
  if (start.dateKey !== end.dateKey) return false;
  return start.minutes >= clockMinutes(policy.windowStart, 'windowStart')
    && end.minutes <= clockMinutes(policy.windowEnd, 'windowEnd');
}

function intervalsOverlap(left, right) {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

export function chooseEarliestInterviewSlot(slots, busyIntervals = [], policy = INTERVIEW_BOOKING_POLICY) {
  validateInterviewBookingPolicy(policy);
  if (!Array.isArray(slots) || slots.length > 256) throw new Error('slots: expected bounded array');
  if (!Array.isArray(busyIntervals) || busyIntervals.length > 512) throw new Error('busyIntervals: expected bounded array');

  const busy = busyIntervals.map((interval, index) => normalizeInterval(interval, `busyIntervals[${index}]`));
  const candidates = slots.map((slot, index) => normalizeInterval(slot, `slots[${index}]`));
  const eligible = candidates.filter((candidate) => {
    const external = { start: candidate.start, end: candidate.end };
    return isSlotWithinInterviewWindow(external, policy)
      && !busy.some((interval) => intervalsOverlap(candidate, interval));
  });
  eligible.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (eligible.length === 0) return null;
  return Object.freeze({ start: eligible[0].start, end: eligible[0].end });
}

function safeSchedulingUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value.trim() !== value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return value;
}

export function planInterviewBooking(input, policy = INTERVIEW_BOOKING_POLICY) {
  validateInterviewBookingPolicy(policy);
  if (!exactEnumerableDataKeys(input, [
    'busyIntervals',
    'legitimate',
    'opportunityKind',
    'schedulingUrl',
    'slots',
    'thirdPartyCompletable',
  ])) {
    return Object.freeze({ disposition: 'skip', reason: 'invalid_booking_context' });
  }
  if (input.legitimate !== true || input.opportunityKind !== policy.opportunityKind) {
    return Object.freeze({ disposition: 'skip', reason: 'opportunity_not_eligible' });
  }
  if (input.thirdPartyCompletable !== true && input.thirdPartyCompletable !== false) {
    return Object.freeze({ disposition: 'skip', reason: 'invalid_execution_capability' });
  }

  let selectedSlot;
  try {
    selectedSlot = chooseEarliestInterviewSlot(input.slots, input.busyIntervals, policy);
  } catch {
    return Object.freeze({ disposition: 'skip', reason: 'invalid_slot_evidence' });
  }
  if (!selectedSlot) {
    return Object.freeze({ disposition: 'skip', reason: 'no_conflict_free_slot_in_window' });
  }

  if (input.thirdPartyCompletable === true && policy.autoBookWhenSupported === true) {
    return Object.freeze({ disposition: 'book', reason: 'earliest_conflict_free_slot', selectedSlot });
  }

  const schedulingUrl = safeSchedulingUrl(input.schedulingUrl);
  if (policy.externalSchedulerPolicy === 'surface_link_when_unsupported' && schedulingUrl) {
    return Object.freeze({
      disposition: 'surface_link',
      reason: 'third_party_scheduler_not_completable',
      selectedSlot,
      schedulingUrl,
    });
  }

  return Object.freeze({ disposition: 'skip', reason: 'manual_scheduler_link_required' });
}
