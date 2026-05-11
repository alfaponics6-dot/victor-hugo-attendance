// Canonical strings for attendance state and justification.
// These match the values the server stores in the `attendance.status` and
// `attendance.justification` columns. Comparing against the constant
// surfaces typos at lint time and gives one place to migrate from if the
// schema ever changes.
export const STATUS = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  UNMARKED: 'unmarked',
});

export const JUSTIFICATION = Object.freeze({
  JUSTIFIED: 'justificada',
  UNJUSTIFIED: 'injustificada',
});
