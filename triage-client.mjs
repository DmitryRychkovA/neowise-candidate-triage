import { isReadyResult, manualReview } from "./triage-result.mjs";

export function createTriageController({ render, fetchImpl = fetch, timeoutMs = 5000 }) {
  let latest = 0;
  let active;
  const empty = (status) => ({ status, topic: null, draft: null });

  function reset() {
    latest += 1;
    active?.abort();
    active = undefined;
    render(empty("idle"));
  }

  async function submit(text) {
    const id = ++latest;
    active?.abort();
    active = undefined;
    if (typeof text !== "string" || !text.trim()) {
      render(empty("invalid_input"));
      return;
    }
    // Старый черновик очищается сразу: его нельзя принять за новый результат.
    render(empty("loading"));
    const controller = new AbortController();
    active = controller;
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("API timeout"));
          controller.abort();
        }, timeoutMs);
      });
      const response = await Promise.race([
        (async () => {
          const reply = await fetchImpl("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text.trim() }),
            signal: controller.signal,
          });
          return { code: reply.status, body: await reply.json() };
        })(),
        deadline,
      ]);
      if (id !== latest) return;
      if (response.code === 400 && response.body?.status === "invalid_input") {
        render(empty("invalid_input"));
      } else if (response.code === 200 && response.body?.status === "ready" && isReadyResult(response.body)) {
        render({ status: "ready", topic: response.body.topic, draft: response.body.draft.trim() });
      } else {
        render(manualReview());
      }
    } catch {
      // Запоздалые ошибки тоже не должны стирать более свежий ответ.
      if (id === latest) render(manualReview());
    } finally {
      clearTimeout(timer);
      if (id === latest) active = undefined;
    }
  }

  return { submit, reset };
}
