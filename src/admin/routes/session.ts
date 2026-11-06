/** Logging in and out. */
import { config } from "../../config.js";
import { getStore } from "../../store/index.js";
import { isLoggedIn, login, logoutCookie } from "../auth.js";
import { field, jsonResponse, type Route } from "../http.js";

export const sessionRoutes: Route[] = [
  {
    method: "GET",
    path: "session",
    public: true,
    handler: (req) => ({ passwordSet: Boolean(config.admin.password), loggedIn: isLoggedIn(req.request) }),
  },
  {
    method: "POST",
    path: "session",
    public: true,
    async handler(req) {
      const cookie = await login(req, field(await req.json(), "password", { max: 200 }), getStore());
      return jsonResponse({ loggedIn: true }, 200, { "set-cookie": cookie });
    },
  },
  {
    method: "DELETE",
    path: "session",
    public: true,
    handler: (req) => jsonResponse({ loggedIn: false }, 200, { "set-cookie": logoutCookie(req) }),
  },
];
