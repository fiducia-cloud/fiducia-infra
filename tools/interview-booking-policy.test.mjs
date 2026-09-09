import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  INTERVIEW_BOOKING_POLICY,
  chooseEarliestInterviewSlot,
  isSlotWithinInterviewWindow,
  planInterviewBooking,
  validateInterviewBookingPolicy,
} from './interview-booking-policy.mjs';

const policyFixture = JSON.parse(fs.readFileSync(
  new URL('../contracts/interview-booking/instances/InterviewBookingPolicy/valid/default.json', import.meta.url),
  'utf8',
));

const slot = (start, end) => ({ start, end });

function bookingInput(overrides = {}) {
  return {
    opportunityKind: 'engineering_job',
    legitimate: true,
    slots: [slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z')],
    busyIntervals: [],
    thirdPartyCompletable: true,
    schedulingUrl: 'https://scheduler.example/interview',
    ...overrides,
  };
}

test('runtime policy is exactly the contract corpus policy', () => {
  assert.deepEqual(INTERVIEW_BOOKING_POLICY, policyFixture);
  assert.equal(validateInterviewBookingPolicy(policyFixture), true);
});

test('policy validation fails closed on timezone or window drift', () => {
  assert.throws(
    () => validateInterviewBookingPolicy({ ...policyFixture, timezone: 'America/Lima' }),
    /timezone/,
  );
  assert.throws(
    () => validateInterviewBookingPolicy({ ...policyFixture, windowEnd: '20:00' }),
    /windowEnd/,
  );
});

test('policy validation rejects extra fields and accessors', () => {
  assert.throws(() => validateInterviewBookingPolicy({ ...policyFixture, allowAnything: true }), /malformed/);
  const accessor = { ...policyFixture };
  let invoked = false;
  Object.defineProperty(accessor, 'timezone', {
    enumerable: true,
    get() {
      invoked = true;
      return 'America/New_York';
    },
  });
  assert.throws(() => validateInterviewBookingPolicy(accessor), /malformed/);
  assert.equal(invoked, false);
});

test('summer Eastern boundary includes 10:00 and slots ending exactly at 19:00', () => {
  assert.equal(isSlotWithinInterviewWindow(slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z')), true);
  assert.equal(isSlotWithinInterviewWindow(slot('2026-09-09T22:30:00Z', '2026-09-09T23:00:00Z')), true);
});

test('summer Eastern boundary rejects starts before 10 and finishes after 19', () => {
  assert.equal(isSlotWithinInterviewWindow(slot('2026-09-09T13:59:00Z', '2026-09-09T14:30:00Z')), false);
  assert.equal(isSlotWithinInterviewWindow(slot('2026-09-09T22:45:00Z', '2026-09-09T23:15:00Z')), false);
});

test('IANA Eastern timezone handles winter standard time without a fixed UTC offset', () => {
  assert.equal(isSlotWithinInterviewWindow(slot('2026-12-15T15:00:00Z', '2026-12-15T15:30:00Z')), true);
  assert.equal(isSlotWithinInterviewWindow(slot('2026-12-15T23:30:00Z', '2026-12-16T00:00:00Z')), true);
});

test('slot selection skips a calendar conflict and chooses the earliest remaining slot', () => {
  const selected = chooseEarliestInterviewSlot([
    slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'),
    slot('2026-09-09T15:00:00Z', '2026-09-09T15:30:00Z'),
  ], [
    slot('2026-09-09T13:50:00Z', '2026-09-09T14:15:00Z'),
  ]);
  assert.deepEqual(selected, slot('2026-09-09T15:00:00Z', '2026-09-09T15:30:00Z'));
});

test('touching calendar intervals are not treated as conflicts', () => {
  const selected = chooseEarliestInterviewSlot([
    slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'),
  ], [
    slot('2026-09-09T13:30:00Z', '2026-09-09T14:00:00Z'),
  ]);
  assert.deepEqual(selected, slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'));
});

test('planner books the earliest conflict-free slot only when execution is supported', () => {
  assert.deepEqual(planInterviewBooking(bookingInput()), {
    disposition: 'book',
    reason: 'earliest_conflict_free_slot',
    selectedSlot: slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'),
  });
});

test('planner surfaces scheduler link instead of claiming an unsupported booking', () => {
  assert.deepEqual(planInterviewBooking(bookingInput({ thirdPartyCompletable: false })), {
    disposition: 'surface_link',
    reason: 'third_party_scheduler_not_completable',
    selectedSlot: slot('2026-09-09T14:00:00Z', '2026-09-09T14:30:00Z'),
    schedulingUrl: 'https://scheduler.example/interview',
  });
});

test('planner rejects irrelevant or illegitimate opportunities', () => {
  assert.deepEqual(planInterviewBooking(bookingInput({ opportunityKind: 'sales_job' })), {
    disposition: 'skip',
    reason: 'opportunity_not_eligible',
  });
  assert.deepEqual(planInterviewBooking(bookingInput({ legitimate: false })), {
    disposition: 'skip',
    reason: 'opportunity_not_eligible',
  });
});

test('planner refuses malformed or missing manual scheduler URLs', () => {
  assert.deepEqual(planInterviewBooking(bookingInput({
    thirdPartyCompletable: false,
    schedulingUrl: 'http://scheduler.example/interview',
  })), {
    disposition: 'skip',
    reason: 'manual_scheduler_link_required',
  });
});

test('planner fails closed on malformed slot evidence', () => {
  assert.deepEqual(planInterviewBooking(bookingInput({
    slots: [{ start: 'not-a-time', end: 'also-not-a-time' }],
  })), {
    disposition: 'skip',
    reason: 'invalid_slot_evidence',
  });
});

test('planner does not execute getters in an untrusted booking context', () => {
  const input = bookingInput();
  let invoked = false;
  Object.defineProperty(input, 'schedulingUrl', {
    enumerable: true,
    get() {
      invoked = true;
      return 'https://scheduler.example/interview';
    },
  });
  assert.deepEqual(planInterviewBooking(input), {
    disposition: 'skip',
    reason: 'invalid_booking_context',
  });
  assert.equal(invoked, false);
});
