import { handleMigrate } from "../src/migrate.js";

// POST /api/migrate — one-time copy from Upstash Redis to Supabase (signed).
export default {
  fetch(request: Request) {
    return handleMigrate(request);
  },
};
