/**
 * Date utility functions for consistent date handling across the application
 * These functions avoid timezone issues by working with local dates
 */

/**
 * Get today's date in YYYY-MM-DD format (local timezone)
 * @returns {string} Date string in YYYY-MM-DD format
 */
export const getTodayDate = () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Convert a Date object to YYYY-MM-DD format (local timezone)
 * @param {Date} date - Date object to convert
 * @returns {string} Date string in YYYY-MM-DD format
 */
export const formatDateToYYYYMMDD = (date) => {
  if (!date || !(date instanceof Date)) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Get current time in HH:MM format (backend expects this format)
 * @returns {string} Time string in HH:MM format
 */
export const getCurrentTime = () => {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

/**
 * Format a date string for display. The locale defaults to whatever the
 * browser is currently in (via `undefined` → user-agent locale). Callers
 * inside React components should pass `i18n.language` so the formatting
 * tracks the user's i18next preference.
 */
export const formatDateForDisplay = (dateString, locale) => {
  if (!dateString) return '';

  const date = parseDateString(dateString);
  if (!date || isNaN(date.getTime())) {
    return dateString;
  }

  return date.toLocaleDateString(locale || undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

/**
 * Parse a YYYY-MM-DD string to a Date object at midnight local time
 * @param {string} dateString - Date string in YYYY-MM-DD format
 * @returns {Date} Date object
 */
export const parseDateString = (dateString) => {
  if (!dateString) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
};

/**
 * Check if a date string is valid YYYY-MM-DD format
 * @param {string} dateString - Date string to validate
 * @returns {boolean} True if valid
 */
export const isValidDateString = (dateString) => {
  if (!dateString) return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = parseDateString(dateString);
  return date instanceof Date && !isNaN(date);
};

/**
 * Get date range (from start to end)
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {string[]} Array of date strings
 */
export const getDateRange = (startDate, endDate) => {
  const dates = [];
  const start = parseDateString(startDate);
  const end = parseDateString(endDate);

  if (!start || !end) return dates;

  const current = new Date(start);
  while (current <= end) {
    dates.push(formatDateToYYYYMMDD(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
};

/**
 * Add days to a date
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @param {number} days - Number of days to add
 * @returns {string} New date in YYYY-MM-DD format
 */
export const addDays = (dateString, days) => {
  const date = parseDateString(dateString);
  if (!date) return '';
  date.setDate(date.getDate() + days);
  return formatDateToYYYYMMDD(date);
};
