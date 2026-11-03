import { httpAdapter } from "./http.js";
import { qqAdapter } from "./qq.js";
import { telegramAdapter } from "./telegram.js";
import type { ChannelAdapter } from "./types.js";

/** Add a channel: implement ChannelAdapter and register it here. */
const adapters: ChannelAdapter[] = [qqAdapter, telegramAdapter, httpAdapter];

export const channels = new Map(adapters.map((a) => [a.name, a]));
