// Создание Bot и регистрация всех хендлеров.

import { Bot } from "grammy";
import { config } from "./config.ts";
import { registerJoinRequest } from "./handlers/joinRequest.ts";
import { registerChatMember } from "./handlers/chatMember.ts";
import { registerCommands } from "./handlers/commands.ts";
import { registerCallbacks } from "./handlers/callbacks.ts";
import { registerModeration } from "./handlers/moderation.ts";

export const bot = new Bot(config.botToken);

registerJoinRequest(bot);
registerChatMember(bot);
registerCommands(bot);
registerCallbacks(bot);

// Модерация читает сообщения чата — подключаем только если задан LLM-ключ.
// Команды зарегистрированы раньше и потребляют свои сообщения, не доходя сюда.
if (config.moderationEnabled) {
  registerModeration(bot);
}

bot.catch((err) => {
  console.error("Ошибка в обработчике:", err.error);
});
