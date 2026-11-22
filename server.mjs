import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";
import { isReadyResult, manualReview } from "./triage-result.mjs";

export const AI_TIMEOUT_MS = 300;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function askModel(text, model) {
  const controller = new AbortController();
  let timer;
  try {
    // Race ограничивает ожидание даже у провайдера, который игнорирует signal.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("AI timeout"));
        controller.abort();
      }, AI_TIMEOUT_MS);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => model(text, { signal: controller.signal })),
      deadline,
    ]);
    if (typeof raw !== "string") return manualReview();
    const result = JSON.parse(raw);
    if (!isReadyResult(result)) return manualReview();
    // Не переносим произвольные поля модели в публичный ответ API.
    return { status: "ready", topic: result.topic, draft: result.draft.trim() };
  } catch {
    return manualReview();
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, model) {
  let input;
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!input || Array.isArray(input) || typeof input.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  return json(response, 200, await askModel(input.text.trim(), model));
}

// Импорт модуля не запускает сервер; тест выбирает свободный порт сам.
export function createTriageServer({ model = classify } = {}) {
  const assets = new Map([
    ["/", ["index.html", "text/html"]],
    ["/triage-client.mjs", ["triage-client.mjs", "text/javascript"]],
    ["/triage-result.mjs", ["triage-result.mjs", "text/javascript"]],
  ]);
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && assets.has(request.url)) {
        const [file, type] = assets.get(request.url);
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        response.end(content);
        return;
      }
      if (request.method !== "POST" || request.url !== "/api/triage") {
        return json(response, 404, { status: "not_found" });
      }
      await handleTriage(request, response, model);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  createTriageServer().listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}
