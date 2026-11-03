import { channelFromUrl, handleWebhook } from "../../src/webhook.js";

// POST /api/webhook/:channel  (qq | telegram | http)
export default {
  fetch(request: Request) {
    return handleWebhook(request, channelFromUrl(request.url));
  },
};
