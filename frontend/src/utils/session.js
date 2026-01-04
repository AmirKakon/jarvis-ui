/**
 * Session management utilities.
 * Handles session ID generation and persistence in localStorage.
 */

const SESSION_KEY = 'jarvis_session_id';

/**
 * Generate a new UUID v4.
 * @returns {string} A new UUID
 */
export function generateSessionId() {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Get the current session ID from localStorage, or generate a new one.
 * @returns {string} The session ID
 */
export function getSessionId() {
  let sessionId = localStorage.getItem(SESSION_KEY);
  
  if (!sessionId) {
    sessionId = generateSessionId();
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  
  return sessionId;
}

/**
 * Set a specific session ID in localStorage.
 * @param {string} sessionId - The session ID to set
 */
export function setSessionId(sessionId) {
  localStorage.setItem(SESSION_KEY, sessionId);
}

/**
 * Clear the current session and generate a new one.
 * @returns {string} The new session ID
 */
export function resetSession() {
  const newSessionId = generateSessionId();
  localStorage.setItem(SESSION_KEY, newSessionId);
  return newSessionId;
}

/**
 * Check if a session ID exists in localStorage.
 * @returns {boolean} True if a session ID exists
 */
export function hasSession() {
  return localStorage.getItem(SESSION_KEY) !== null;
}

