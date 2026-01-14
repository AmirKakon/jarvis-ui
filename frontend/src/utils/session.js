/**
 * Session management utilities.
 * Handles session ID generation and fetching from backend.
 * Sessions are shared across devices - the latest session is always used.
 */

const SESSION_KEY = 'jarvis_session_id';

/**
 * Get the API URL for backend requests.
 * @returns {string} The API base URL
 */
function getApiUrl() {
  // In production (built app), use relative path (nginx proxies to backend)
  // In development, use the backend directly
  if (import.meta.env.DEV) {
    return 'http://localhost:20005';
  }
  // In production, requests go through nginx proxy
  return '';
}

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
 * Fetch the latest session from the backend.
 * This enables shared sessions across devices.
 * @returns {Promise<string|null>} The latest session ID or null if none exists
 */
export async function fetchLatestSession() {
  try {
    const apiUrl = getApiUrl();
    const response = await fetch(`${apiUrl}/api/session/latest/get`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.warn('Failed to fetch latest session:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    if (data.session_id) {
      console.log('Found latest session:', data.session_id);
      // Store it locally for quick access
      localStorage.setItem(SESSION_KEY, data.session_id);
      return data.session_id;
    }
    
    return null;
  } catch (error) {
    console.warn('Error fetching latest session:', error);
    return null;
  }
}

/**
 * Get the current session ID.
 * First tries to fetch the latest session from the backend.
 * If no session exists, generates a new one.
 * @returns {Promise<string>} The session ID
 */
export async function getSessionId() {
  // Try to get the latest session from the backend
  const latestSession = await fetchLatestSession();
  
  if (latestSession) {
    return latestSession;
  }
  
  // No existing session, create a new one
  const newSessionId = generateSessionId();
  localStorage.setItem(SESSION_KEY, newSessionId);
  console.log('Created new session:', newSessionId);
  return newSessionId;
}

/**
 * Get the cached session ID from localStorage (synchronous).
 * Use this when you need immediate access and have already called getSessionId().
 * @returns {string|null} The cached session ID or null
 */
export function getCachedSessionId() {
  return localStorage.getItem(SESSION_KEY);
}

/**
 * Set a specific session ID in localStorage.
 * @param {string} sessionId - The session ID to set
 */
export function setSessionId(sessionId) {
  localStorage.setItem(SESSION_KEY, sessionId);
}

/**
 * Create a new session (only when user clicks "New Session").
 * Also triggers cleanup of old sessions on the backend.
 * @returns {string} The new session ID
 */
export function createNewSession() {
  const newSessionId = generateSessionId();
  localStorage.setItem(SESSION_KEY, newSessionId);
  
  // Trigger cleanup of old sessions in the background
  triggerSessionCleanup(newSessionId);
  
  console.log('Created new session (user requested):', newSessionId);
  return newSessionId;
}

/**
 * @deprecated Use createNewSession() instead
 */
export function resetSession() {
  return createNewSession();
}

/**
 * Trigger cleanup of old sessions on the backend.
 * This will summarize old sessions and delete them.
 * @param {string} newSessionId - The new session ID to exclude from cleanup
 */
export async function triggerSessionCleanup(newSessionId) {
  try {
    const apiUrl = getApiUrl();
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
