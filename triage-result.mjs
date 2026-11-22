const TOPICS = new Set(["delivery", "pricing", "other"]);

export function isReadyResult(result) {
  return !!result && !Array.isArray(result) && TOPICS.has(result.topic)
    && typeof result.draft === "string" && result.draft.trim().length > 0;
}

export function manualReview() {
  return { status: "manual_review", topic: null, draft: null };
}
