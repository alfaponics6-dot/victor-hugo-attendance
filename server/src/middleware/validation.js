const { body, param, query, validationResult } = require('express-validator');

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// NOTE on `.escape()`: we deliberately do NOT chain `.escape()` on text fields.
// express-validator's escape() HTML-encodes characters (`<>"'&`), which is the
// wrong defense for our threat model: data lands in SQLite via parameterized
// queries (no injection) and is rendered by React (which already escapes).
// Escaping at the validator turns "O'Connor" into "O&#x27;Connor" on disk,
// which then displays mangled in the UI. The correct sanitization here is
// `.trim()` plus length bounds.
//
// Numeric `param`/`query` validators do not need escape() either — once
// .isInt() passes there are no HTML-relevant characters left.

// Auth validation rules.
// Password and accessCode are bounded so a 1MB body can't pin bcrypt for
// seconds — bcrypt cost grows linearly with input length and the only sane
// upper bound for a user-typed credential is ~200 chars.
const validateLogin = [
  body('leaderId')
    .notEmpty().withMessage('Leader ID is required')
    .isInt({ min: 1 }).withMessage('Leader ID must be a positive integer'),
  body('password')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ min: 1, max: 200 }).withMessage('Password length must be between 1 and 200 characters'),
  body('accessCode')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ min: 1, max: 200 }).withMessage('Access code length must be between 1 and 200 characters'),
  handleValidationErrors
];

// Student validation rules
const validateStudent = [
  body('name')
    .notEmpty().withMessage('Student name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters')
    .trim(),
  body('studentId')
    .optional({ checkFalsy: true })
    .isLength({ max: 50 }).withMessage('Student ID must be less than 50 characters')
    .trim(),
  body('email')
    .optional({ checkFalsy: true })
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail()
    .isLength({ max: 100 }).withMessage('Email must be less than 100 characters'),
  handleValidationErrors
];

const validateStudentUpdate = [
  param('studentId')
    .isInt({ min: 1 }).withMessage('Student ID must be a positive integer'),
  body('name')
    .notEmpty().withMessage('Student name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters')
    .trim(),
  body('student_id')
    .optional({ checkFalsy: true })
    .isLength({ max: 50 }).withMessage('Student ID must be less than 50 characters')
    .trim(),
  body('email')
    .optional({ checkFalsy: true })
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail()
    .isLength({ max: 100 }).withMessage('Email must be less than 100 characters'),
  handleValidationErrors
];

// Attendance validation rules.
// projectId and leaderId are NOT validated here - the route handler always
// overrides them from the authenticated JWT for security. We accept them in
// the body for backwards compatibility but ignore the values.
const validateAttendance = [
  body('studentId')
    .notEmpty().withMessage('Student ID is required')
    .isInt({ min: 1 }).withMessage('Student ID must be a positive integer'),
  body('date')
    .notEmpty().withMessage('Date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date must be in YYYY-MM-DD format')
    .isISO8601().withMessage('Date must be a valid date'),
  body('time')
    .optional()
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Time must be in HH:MM format'),
  body('status')
    .notEmpty().withMessage('Status is required')
    .isIn(['present', 'absent']).withMessage('Status must be either "present" or "absent"')
    .trim(),
  body('justification')
    .optional({ nullable: true })
    .isIn(['justificada', 'injustificada']).withMessage('Justification must be either "justificada" or "injustificada"')
    .trim(),
  body('observation')
    .optional({ nullable: true })
    .isLength({ max: 500 }).withMessage('Observation must be less than 500 characters')
    .trim(),
  // list_number: 1 = primera lista, 2 = segunda lista. Optional; the route
  // defaults it to 1 when absent.
  body('listNumber')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 2 }).withMessage('listNumber must be 1 or 2'),
  handleValidationErrors
];

// Daily sign-off (jornada) validators.
const validateCloseDay = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isInt({ min: 1 }).withMessage('projectId must be a positive integer'),
  body('date')
    .notEmpty().withMessage('date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be YYYY-MM-DD')
    .isISO8601().withMessage('date must be a valid date'),
  handleValidationErrors
];

const validateCloseSession = [
  body('date')
    .notEmpty().withMessage('date is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be YYYY-MM-DD')
    .isISO8601().withMessage('date must be a valid date'),
  handleValidationErrors
];

// Parameter validation
const validateProjectId = [
  param('projectId')
    .isInt({ min: 1 }).withMessage('Project ID must be a positive integer'),
  handleValidationErrors
];

const validateLeaderId = [
  param('leaderId')
    .isInt({ min: 1 }).withMessage('Leader ID must be a positive integer'),
  handleValidationErrors
];

const validateStudentId = [
  param('studentId')
    .isInt({ min: 1 }).withMessage('Student ID must be a positive integer'),
  handleValidationErrors
];

const validateRotation = [
  param('projectId')
    .isInt({ min: 1 }).withMessage('Project ID must be a positive integer'),
  param('rotationNumber')
    .isInt({ min: 1 }).withMessage('Rotation number must be a positive integer'),
  handleValidationErrors
];

const validateDateParam = [
  param('date')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Date must be in YYYY-MM-DD format')
    .isISO8601().withMessage('Date must be a valid date'),
  handleValidationErrors
];

// Query parameter validation
const validateThreshold = [
  query('threshold')
    .optional()
    .isInt({ min: 0, max: 100 }).withMessage('Threshold must be between 0 and 100'),
  handleValidationErrors
];

const validateDays = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 }).withMessage('Days must be between 1 and 365'),
  handleValidationErrors
];

// Used by stats endpoints that accept ?date=, ?startDate=, ?endDate=. Each is
// optional independently; range mode is enforced by the route. Bounded
// matches so a crafted year-9999 doesn't blow up SQLite's BETWEEN clause.
const validateDateQuery = [
  query('date')
    .optional({ nullable: true, checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date must be YYYY-MM-DD')
    .isISO8601().withMessage('date must be a valid ISO date'),
  query('startDate')
    .optional({ nullable: true, checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('startDate must be YYYY-MM-DD')
    .isISO8601().withMessage('startDate must be a valid ISO date'),
  query('endDate')
    .optional({ nullable: true, checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('endDate must be YYYY-MM-DD')
    .isISO8601().withMessage('endDate must be a valid ISO date'),
  handleValidationErrors
];

module.exports = {
  validateLogin,
  validateStudent,
  validateStudentUpdate,
  validateAttendance,
  validateProjectId,
  validateLeaderId,
  validateStudentId,
  validateRotation,
  validateDateParam,
  validateThreshold,
  validateDays,
  validateDateQuery,
  validateCloseDay,
  validateCloseSession,
  handleValidationErrors
};
