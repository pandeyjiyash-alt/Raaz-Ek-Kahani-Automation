/** Default slot: 1:30 PM Asia/Kolkata (08:00 UTC), the user's daily slot.
 * Resolve AFTER media uploads, so a long PUT cannot silently miss the selected slot. */
export function resolveSchedule(now = new Date(), explicit?: string, minimumLeadMs = 120_000) {
  if (explicit) { const value = Date.parse(explicit); if (!Number.isFinite(value) || value <= now.getTime() + minimumLeadMs) throw Error('Selected schedule is too close or elapsed; no post submitted and no publish-now fallback'); return new Date(value).toISOString(); }
  const india = new Date(now.getTime() + 330 * 60_000);
  const slot = new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate(), 8, 0));
  if (slot.getTime() <= now.getTime() + minimumLeadMs) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot.toISOString();
}
