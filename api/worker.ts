import { handleWorker } from "../src/worker.js";

// POST /api/worker — internal hand-off between runs (signed).
export default {
  fetch(request: Request) {
    return handleWorker(request);
  },
};
