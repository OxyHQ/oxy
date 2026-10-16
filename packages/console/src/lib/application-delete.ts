/**
 * Confirming an application's deletion (ADR 0041 D8).
 *
 * Deleting an application deletes every file it owns at once, so the person
 * types the application's name. `DELETE /applications/:appId` refuses anything
 * but the current name, compared trimmed and case-sensitively; the dialog asks
 * the same question so its button is enabled exactly when the API would agree.
 */
export function isDeleteConfirmed(typed: string, name: string): boolean {
  return typed.trim().length > 0 && typed.trim() === name.trim();
}
