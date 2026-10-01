export function canSettleBeforeDeadline(
  nowUnix: number,
  deadlineUnix: number,
  safetyMarginSeconds: number
): boolean {
  if (!Number.isSafeInteger(safetyMarginSeconds) || safetyMarginSeconds < 0) {
    throw new RangeError("safety margin must be a non-negative safe integer");
  }
  return nowUnix + safetyMarginSeconds < deadlineUnix;
}
