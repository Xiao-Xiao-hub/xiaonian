/* Support-chat transport stays in one place while the server contract settles. */
const api = require("../../utils/api");

const unwrap = (value) => (value && value.data ? value.data : value);

function key(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function chatSession() {
  return api.post("/v1/support/chat/sessions").then(unwrap);
}

function chatDetail(id) {
  return api.get(`/v1/support/chat/sessions/${encodeURIComponent(id)}`).then(unwrap);
}

function chatTurn(id, text, idempotencyKey) {
  return api
    .post(`/v1/support/chat/sessions/${encodeURIComponent(id)}/turns`, {
      text,
      idempotencyKey,
    })
    .then(unwrap);
}

function knowledge() {
  return api
    .get("/v1/support/knowledge")
    .then(unwrap)
    .then((value) =>
      Array.isArray(value)
        ? value
        : Array.isArray(value && value.faqs)
          ? value.faqs
          : Array.isArray(value && value.items)
            ? value.items
            : [],
    );
}

function tickets() {
  return api.get("/v1/support/tickets").then(unwrap);
}

function ticket(id) {
  return api.get(`/v1/support/tickets/${encodeURIComponent(id)}`).then(unwrap);
}

function notificationOptions() {
  return api.get("/v1/support/notifications/options").then(unwrap);
}

function createTicket(turnId, content, idempotencyKey, subscription) {
  return api
    .post("/v1/support/tickets", { turnId, content, idempotencyKey, ...(subscription ? { subscription } : {}) })
    .then(unwrap);
}

module.exports = {
  key,
  chatSession,
  chatDetail,
  chatTurn,
  knowledge,
  tickets,
  ticket,
  notificationOptions,
  createTicket,
};
