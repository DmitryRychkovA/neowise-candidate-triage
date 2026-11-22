import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createTriageServer } from "./server.mjs";
import { createTriageController } from "./triage-client.mjs";

const manual = { status: "manual_review", topic: null, draft: null };
const ready = (draft = "Готовый ответ") => ({ status: "ready", topic: "delivery", draft });
const response = (body, status = 200) => ({ status, json: async () => body });

async function serve(t, options) {
  const server = createTriageServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/api/triage`;
}

async function post(url, body) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(2000),
  });
  return { code: reply.status, body: await reply.json() };
}

test("HTTP: некорректный ввод отклоняется до вызова модели", async (t) => {
  let calls = 0;
  const url = await serve(t, { model: async () => { calls++; return "{}"; } });
  for (const body of ["", "{", "null", "[]", "123", "{}", '{"text":null}', '{"text":7}', '{"text":{}}', '{"text":""}', '{"text":"  \\n\\t"}']) {
    await t.test(body || "пустое тело", async () => {
      assert.deepEqual(await post(url, body), { code: 400, body: { status: "invalid_input" } });
    });
  }
  assert.equal(calls, 0);
});

test("HTTP: обычные заявки работают с исходным имитатором", async (t) => {
  const url = await serve(t);
  for (const [text, topic] of [["Когда доставка?", "delivery"], ["Какая стоимость?", "pricing"], ["Здравствуйте", "other"]]) {
    const result = await post(url, JSON.stringify({ text }));
    assert.deepEqual(result, { code: 200, body: { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." } });
  }
});

test("HTTP: все пять сценариев сбоя исходного имитатора требуют ручного разбора", async (t) => {
  const url = await serve(t);
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(marker, async () => {
      const start = performance.now();
      assert.deepEqual(await post(url, JSON.stringify({ text: marker })), { code: 200, body: manual });
      if (marker === "[timeout]") {
        // Допуск учитывает планировщик ОС, но не пропускает ожидание mock в 1200 мс.
        assert.ok(performance.now() - start < 900, "ответ должен прийти раньше завершения медленной модели");
      }
    });
  }
});

test("HTTP: дедлайн ограничивает даже модель, игнорирующую отмену", async (t) => {
  let modelSignal;
  const url = await serve(t, { model: (_text, { signal }) => {
    modelSignal = signal;
    return new Promise(() => {});
  } });
  const start = performance.now();
  assert.deepEqual(await post(url, '{"text":"заявка"}'), { code: 200, body: manual });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 260 && elapsed < 900, `ожидали дедлайн 300 мс, получили ${elapsed}`);
  assert.equal(modelSignal.aborted, true);
});

test("HTTP: валидный JSON ещё не означает правильный ответ модели", async (t) => {
  let output;
  const url = await serve(t, { model: async () => output });
  for (output of ["null", "[]", '"строка"', "{}", '{"topic":"other","draft":false}', '{"topic":"delivery","draft":"\\t\\n"}', { topic: "other", draft: "ответ" }]) {
    assert.deepEqual(await post(url, '{"text":"заявка"}'), { code: 200, body: manual });
  }
  output = '{"status":"anything","topic":"other","draft":"  Ответ  ","secret":"не отдавать"}';
  assert.deepEqual(await post(url, '{"text":"заявка"}'), {
    code: 200, body: { status: "ready", topic: "other", draft: "Ответ" },
  });
});

function page(fetchImpl, options = {}) {
  const states = [];
  const controller = createTriageController({ fetchImpl, render: (state) => states.push(state), ...options });
  return { ...controller, states, last: () => states.at(-1) };
}

test("UI: успешный черновик очищается при следующем сбое", async () => {
  let next = response(ready("Старый черновик"));
  const ui = page(async () => next);
  await ui.submit("доставка");
  assert.equal(ui.last().draft, "Старый черновик");
  next = response(manual);
  const pending = ui.submit("[error]");
  assert.deepEqual(ui.last(), { status: "loading", topic: null, draft: null });
  await pending;
  assert.deepEqual(ui.last(), manual);
});

test("UI: пустой ввод убирает старый результат и не вызывает API", async () => {
  let calls = 0;
  const ui = page(async () => { calls++; return response(ready()); });
  await ui.submit("доставка");
  await ui.submit(" \n\t ");
  assert.deepEqual(ui.last(), { status: "invalid_input", topic: null, draft: null });
  assert.equal(calls, 1);
});

test("UI: ошибки сети, HTTP, JSON и полей приводят к ручному разбору", async (t) => {
  const failures = [
    ["сеть", async () => { throw new Error("offline"); }],
    ["HTTP 500", async () => response(ready(), 500)],
    ["битый JSON", async () => ({ status: 200, json: async () => { throw new SyntaxError(); } })],
    ["неизвестная тема", async () => response({ ...ready(), topic: "unknown" })],
    ["пустой черновик", async () => response(ready("  "))],
    ["неверный статус", async () => response({ ...ready(), status: "unknown" })],
  ];
  for (const [name, failure] of failures) {
    await t.test(name, async () => {
      let current = async () => response(ready("Предыдущий ответ"));
      const ui = page((...args) => current(...args));
      await ui.submit("первая заявка");
      current = failure;
      await ui.submit("вторая заявка");
      assert.deepEqual(ui.last(), manual);
    });
  }
});

test("UI: зависший API не оставляет бесконечную загрузку", async () => {
  let signal;
  const ui = page((_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 20 });
  await ui.submit("заявка");
  assert.deepEqual(ui.last(), manual);
  assert.equal(signal.aborted, true);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("UI: запоздалый успех или ошибка A не перекрывают результат B", async (t) => {
  for (const lateError of [false, true]) {
    await t.test(lateError ? "поздняя ошибка" : "поздний ответ", async () => {
      const a = deferred(), b = deferred();
      let calls = 0;
      const ui = page(() => (++calls === 1 ? a.promise : b.promise));
      const first = ui.submit("A");
      const second = ui.submit("B");
      b.resolve(response(ready("Ответ B")));
      await second;
      if (lateError) a.reject(new Error("A failed"));
      else a.resolve(response(ready("Ответ A")));
      await first;
      assert.deepEqual(ui.last(), ready("Ответ B"));
    });
  }
});

test("UI: завершение A не выключает загрузку B", async () => {
  const a = deferred(), b = deferred();
  let calls = 0;
  const ui = page(() => (++calls === 1 ? a.promise : b.promise));
  const first = ui.submit("A");
  const second = ui.submit("B");
  a.resolve(response(ready("Ответ A")));
  await first;
  assert.deepEqual(ui.last(), { status: "loading", topic: null, draft: null });
  b.resolve(response(ready("Ответ B")));
  await second;
  assert.deepEqual(ui.last(), ready("Ответ B"));
});

test("UI: изменение исходного текста отменяет применимость старого ответа", async () => {
  const a = deferred();
  const ui = page(() => a.promise);
  const pending = ui.submit("прежний текст");
  ui.reset();
  a.resolve(response(ready("Уже неактуальный ответ")));
  await pending;
  assert.deepEqual(ui.last(), { status: "idle", topic: null, draft: null });
});
