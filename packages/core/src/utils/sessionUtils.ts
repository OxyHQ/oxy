/**
 * Session management utilities
 * 
 * Provides consistent session normalization, deduplication, and sorting
 * to ensure sessions are always displayed in a predictable order.
 */

import type { ClientSession } from '../models/session';

/**
 * Normalize a session to ensure all required fields are present
 */
export function normalizeSession(session: Partial<ClientSession> & { sessionId: string }): ClientSession {
  const now = new Date().toISOString();
  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId || '',
    expiresAt: session.expiresAt || now,
    lastActive: session.lastActive || now,
    userId: session.userId || '',
  };
}

/**
 * Compare two sessions for equality
 */
export function sessionsEqual(a: ClientSession, b: ClientSession): boolean {
  return a.sessionId === b.sessionId;
}

/**
 * Sort sessions by lastActive (most recent first), then by sessionId for stability
 */
export function sortSessions(sessions: ClientSession[]): ClientSession[] {
  return [...sessions].sort((a, b) => {
    // Sort by lastActive descending (most recent first)
    const timeA = new Date(a.lastActive).getTime();
    const timeB = new Date(b.lastActive).getTime();
    if (timeA !== timeB) {
      return timeB - timeA; // Descending order
    }
    // If lastActive is the same, sort by sessionId for stability
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Deduplicate sessions by sessionId, keeping the most recent version
 */
export function deduplicateSessions(sessions: ClientSession[]): ClientSession[] {
  const sessionMap = new Map<string, ClientSession>();
  
  for (const session of sessions) {
    const existing = sessionMap.get(session.sessionId);
    if (!existing) {
      sessionMap.set(session.sessionId, session);
    } else {
      // Keep the one with more recent lastActive
      const existingTime = new Date(existing.lastActive).getTime();
      const currentTime = new Date(session.lastActive).getTime();
      if (currentTime > existingTime) {
        sessionMap.set(session.sessionId, session);
      }
    }
  }
  
  return Array.from(sessionMap.values());
}

/**
 * Deduplicate sessions by userId, keeping only one session per user
 * Priority: 1) Active session (if provided), 2) Most recent session
 * This prevents showing duplicate accounts for the same user
 */
export function deduplicateSessionsByUserId(
  sessions: ClientSession[],
  activeSessionId?: string | null
): ClientSession[] {
  if (!sessions.length) return [];
  
  const userSessionMap = new Map<string, ClientSession>();
  
  for (const session of sessions) {
    if (!session.userId) continue; // Skip sessions without userId
    
    const existing = userSessionMap.get(session.userId);
    if (!existing) {
      userSessionMap.set(session.userId, session);
    } else {
      // Prioritize active session
      const isCurrentActive = activeSessionId && session.sessionId === activeSessionId;
      const isExistingActive = activeSessionId && existing.sessionId === activeSessionId;
      
      if (isCurrentActive && !isExistingActive) {
        userSessionMap.set(session.userId, session);
      } else if (!isCurrentActive && isExistingActive) {
      } else {
        // Neither is active, keep the one with more recent lastActive
        const existingTime = new Date(existing.lastActive).getTime();
        const currentTime = new Date(session.lastActive).getTime();
        if (currentTime > existingTime) {
          userSessionMap.set(session.userId, session);
        }
      }
    }
  }
  
  return Array.from(userSessionMap.values());
}

/**
 * Normalize, deduplicate, and sort sessions
 * This ensures consistent session ordering across the application
 * 
 * @param sessions - Array of sessions to normalize
 * @param activeSessionId - Optional active session ID to prioritize
 * @param deduplicateByUserId - If true, deduplicate by userId (one account per user). Default: true
 */
export function normalizeAndSortSessions(
  sessions: ClientSession[],
  activeSessionId?: string | null,
  deduplicateByUserId = true
): ClientSession[] {
  if (!sessions.length) return [];
  
  // Normalize all sessions
  const normalized = sessions.map(normalizeSession);
  
  // First deduplicate by sessionId (exact duplicates)
  const deduplicatedBySessionId = deduplicateSessions(normalized);
  
  // Then deduplicate by userId if requested (one account per user)
  const finalSessions = deduplicateByUserId
    ? deduplicateSessionsByUserId(deduplicatedBySessionId, activeSessionId)
    : deduplicatedBySessionId;
  
  // Sort consistently
  return sortSessions(finalSessions);
}

/**
 * Merge two session arrays, prioritizing newer data
 * Returns normalized, deduplicated, and sorted sessions
 * 
 * @param existing - Existing sessions array
 * @param incoming - New sessions to merge in
 * @param activeSessionId - Optional active session ID to prioritize
 * @param deduplicateByUserId - If true, deduplicate by userId (one account per user). Default: true
 */
export function mergeSessions(
  existing: ClientSession[],
  incoming: ClientSession[],
  activeSessionId?: string | null,
  deduplicateByUserId = true
): ClientSession[] {
  if (!existing.length && !incoming.length) return [];
  if (!existing.length) return normalizeAndSortSessions(incoming, activeSessionId, deduplicateByUserId);
  if (!incoming.length) return normalizeAndSortSessions(existing, activeSessionId, deduplicateByUserId);
  
  // Normalize both arrays
  const normalizedExisting = existing.map(normalizeSession);
  const normalizedIncoming = incoming.map(normalizeSession);
  
  // Create a map with existing sessions (by sessionId)
  const sessionMap = new Map<string, ClientSession>();
  
  // Add existing sessions first
  for (const session of normalizedExisting) {
    sessionMap.set(session.sessionId, session);
  }
  
  // Merge incoming sessions - backend data always replaces existing
  for (const session of normalizedIncoming) {
    sessionMap.set(session.sessionId, session);
  }
  
  // Convert to array
  const merged = Array.from(sessionMap.values());
  
  // Apply userId deduplication if requested
  const finalSessions = deduplicateByUserId
    ? deduplicateSessionsByUserId(merged, activeSessionId)
    : merged;
  
  // Sort consistently
  return sortSessions(finalSessions);
}

/**
 * Check if two session arrays are equal (same sessionIds in same order)
 */
export function sessionsArraysEqual(a: ClientSession[], b: ClientSession[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  const sortedA = sortSessions(a);
  const sortedB = sortSessions(b);
  
  return sortedA.every((session, index) => 
    sessionsEqual(session, sortedB[index])
  );
}

