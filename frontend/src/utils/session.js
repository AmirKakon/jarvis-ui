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
 * Also triggers cleanup of old sessions on the backend.
 * @returns {string} The new session ID
 */
export function resetSession() {
  const newSessionId = generateSessionId();
  localStorage.setItem(SESSION_KEY, newSessionId);
  
  // Trigger cleanup of old sessions in the background
  triggerSessionCleanup(newSessionId);
  
  return newSessionId;
}

/**
 * Trigger cleanup of old sessions on the backend.
 * This will summarize old sessions and delete them.
 * @param {string} newSessionId - The new session ID to exclude from cleanup
 */
export async function triggerSessionCleanup(newSessionId) {
  try {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:20005';
    const response = await fetch(`${apiUrl}/api/session/cleanup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_session_id: newSessionId,
        min_messages: 2,
      }),
    });
    
    if (!response.ok) {
      console.warn('Session cleanup request failed:', response.status);
    } else {
      console.log('Session cleanup initiated for new session:', newSessionId);
    }
  } catch (error) {
    // Don't block the UI if cleanup fails
    console.warn('Failed to trigger session cleanup:', error);
  }
}

/**
 * Check if a session ID exists in localStorage.
 * @returns {boolean} True if a session ID exists
 */
export function hasSession() {
  return localStorage.getItem(SESSION_KEY) !== null;
}

