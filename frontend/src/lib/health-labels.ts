/** User-facing labels for operator / resource health enums. */
export function healthDisplayLabel(
  state: string | undefined,
  fallback = "Checking",
): string {
  switch (state) {
    case "HEALTHY":
      return "Operational";
    case "DEGRADED":
      return "Active";
    case "UNAVAILABLE":
      return "Unavailable";
    case "NOT_CONFIGURED":
      return "Not configured";
    default:
      return state?.trim() ? state : fallback;
  }
}

export function operatorHealthHeadline(state: string | undefined): string {
  if (state === "HEALTHY") return "operational";
  if (state === "DEGRADED") return "partially available";
  if (state === "UNAVAILABLE") return "unavailable";
  return "status";
}

export function operatorHealthDetail(state: string | undefined): string {
  if (state === "HEALTHY") {
    return "All required local services report healthy. Transaction state machine active.";
  }
  if (state === "DEGRADED") {
    return "Review resource status on the Services screen before operating.";
  }
  if (state === "UNAVAILABLE") {
    return "Operator health is unavailable. Check that the control plane is running.";
  }
  return "Checking operator health from the local control plane.";
}
