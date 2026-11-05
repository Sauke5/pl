type LeaveGuard = (proceed: () => void) => void;
let leaveGuard: LeaveGuard | undefined;

// The shared shell calls this before changing page or logging out. Settings
// owns the draft and dialog; the shell keeps ownership of its navigation.
export function withSettingsNavigation(proceed: () => void) {
  if (leaveGuard) leaveGuard(proceed);
  else proceed();
}
export function registerSettingsGuard(guard: LeaveGuard) {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = undefined;
  };
}
