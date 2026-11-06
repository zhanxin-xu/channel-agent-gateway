import { handleAdmin } from "../src/admin/handler.js";

// The admin console: /admin (the page) and /api/admin/* (its API), see vercel.json.
export default {
  fetch: handleAdmin,
};
