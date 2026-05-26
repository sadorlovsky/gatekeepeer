// Тихий приём заявок: на chat_join_request одобряем, если канал
// зарегистрирован, активен и авто-приём включён. Иначе ничего не делаем.

import type { Bot, Context } from "grammy";
import { getChannel, logJoin } from "../db.ts";

export function registerJoinRequest(bot: Bot): void {
  bot.on("chat_join_request", async (ctx: Context) => {
    const req = ctx.chatJoinRequest;
    if (!req) return;

    const channel = getChannel(req.chat.id);
    if (!channel || channel.active === 0 || channel.auto_approve === 0) {
      // Канал не под управлением или приём выключен — оставляем заявку висеть.
      return;
    }

    try {
      await ctx.approveChatJoinRequest(req.from.id);
      logJoin({
        chatId: req.chat.id,
        userId: req.from.id,
        username: req.from.username ?? null,
        decision: "approved",
        requestedAt: req.date,
      });
    } catch (err) {
      console.error(
        `Не удалось одобрить заявку user=${req.from.id} chat=${req.chat.id}:`,
        err,
      );
    }
  });
}
