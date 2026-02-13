export interface SessionCapacityInput {
  streamableSessions: number;
  pendingSessions: number;
  sseSessions: number;
  maxSessions: number;
}

export function getTotalSessions(input: SessionCapacityInput): number {
  return input.streamableSessions + input.pendingSessions + input.sseSessions;
}

export function hasReachedSessionCapacity(input: SessionCapacityInput): boolean {
  return getTotalSessions(input) >= input.maxSessions;
}
