// Обработка inline-кнопок: переключение авто-приёма по каналу.
// Владение проверяется в setAutoApprove (меняет только свои каналы).

import type { Bot, Context } from "grammy";
import { getChannel, listChannelsByOwner, setAutoApprove } from "../db.ts";
import { channelsKeyboard, TOGGLE_PREFIX } from "../keyboards.ts";

export function registerCallbacks(bot: Bot): void {
  bot.callbackQuery(new RegExp(`^${TOGGLE_PREFIX}:(-?\\d+)$`), async (ctx: Context) => {
    // Клавиатура существует только в личке; владение всё равно проверяется ниже.
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery();
      return;
    }
    const userId = ctx.from?.id;
    const match = ctx.match;
    if (!userId || !match || !Array.isArray(match)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = Number(match[1]);
    const channel = getChannel(chatId);

    // Канал не принадлежит этому пользователю (или исчез) — отказ.
    if (!channel || channel.added_by !== userId) {
      await ctx.answerCallbackQuery({ text: "Этот канал вам не принадлежит." });
      return;
    }

    const next = channel.auto_approve === 0;
    setAutoApprove(chatId, userId, next);

    await ctx.answerCallbackQuery({
      text: next ? "Авто-приём включён ✅" : "Авто-приём выключен ⛔️",
    });

    // Перерисовываем клавиатуру с актуальными отметками.
    const channels = listChannelsByOwner(userId);
    await ctx.editMessageReplyMarkup({ reply_markup: channelsKeyboard(channels) });
  });
}
