import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace Fiducia.JobAutomation;

@id("BookingPolicyVersion")
enum BookingPolicyVersion {
  v1: "v1",
}

@id("BookingTimezone")
enum BookingTimezone {
  eastern: "America/New_York",
}

@id("BookingWindowStart")
enum BookingWindowStart {
  tenEastern: "10:00",
}

@id("BookingWindowEnd")
enum BookingWindowEnd {
  sevenEastern: "19:00",
}

@id("BookingConflictPolicy")
enum BookingConflictPolicy {
  avoidExistingEvents: "avoid_existing_events",
}

@id("BookingSlotPreference")
enum BookingSlotPreference {
  earliestAvailable: "earliest_available",
}

@id("ExternalSchedulerPolicy")
enum ExternalSchedulerPolicy {
  surfaceLinkWhenUnsupported: "surface_link_when_unsupported",
}

@id("BookingOpportunityKind")
enum BookingOpportunityKind {
  engineeringJob: "engineering_job",
}

@id("InterviewBookingPolicy")
model InterviewBookingPolicy {
  schemaVersion: BookingPolicyVersion;
  timezone: BookingTimezone;
  windowStart: BookingWindowStart;
  windowEnd: BookingWindowEnd;
  conflictPolicy: BookingConflictPolicy;
  slotPreference: BookingSlotPreference;
  externalSchedulerPolicy: ExternalSchedulerPolicy;
  opportunityKind: BookingOpportunityKind;
  autoBookWhenSupported: boolean;
  actionableNotificationsOnly: boolean;
}
