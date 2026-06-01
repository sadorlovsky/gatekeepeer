// Команды пульта в личке. Данные скоупятся по пользователю (ctx.from.id).

import type { Bot, Context } from "grammy";
import {
  listChannelsByOwner,
  listPendingWelcome,
  markWelcomePending,
  statsByOwner,
} from "../db.ts";
import { channelsKeyboard } from "../keyboards.ts";

const HELP = [
  "🤖 Я автоматически принимаю заявки на вступление в ваши приватные каналы и чаты.",
  "",
  "Как подключить канал:",
  "1. Включите в канале приём по заявкам (invite-ссылка с «Approve new members»).",
  "2. Добавьте меня администратором с правом «Добавлять участников».",
  "3. Я сам обнаружу канал и начну принимать заявки.",
  "",
  "Команды:",
  "/channels — ваши каналы и переключение авто-приёма",
  "/status — сводка по каналам",
  "/stats — сколько заявок принято",
  "/help — эта справка",
].join("\n");

export function registerCommands(bot: Bot): void {
  bot.command("start", async (ctx: Context) => {
    await ctx.reply(HELP);

    // Догоняем приветствия по каналам, подключённым до того, как владелец нажал
    // /start (тогда DM из chatMember не доставился и был отложен).
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from?.id;
    if (!userId) return;
    const pending = await listPendingWelcome(userId);
    for (const ch of pending) {
      try {
        await ctx.reply(
          `✅ Канал «${ch.title ?? ch.chat_id}» подключён.\n` +
            `Авто-приём заявок включён. Управление — /channels.`,
        );
      } catch {
        continue; // не удалось доставить — оставляем флаг, попробуем в следующий раз
      }
      await markWelcomePending(ch.chat_id, false);
    }
  });

  bot.command("help", async (ctx: Context) => {
    await ctx.reply(HELP);
  });

  bot.command("channels", async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const channels = await listChannelsByOwner(userId);
    if (channels.length === 0) {
      await ctx.reply(
        "У вас пока нет подключённых каналов. Добавьте меня админом с правом приглашать — и канал появится здесь.",
      );
      return;
    }

    await ctx.reply("Ваши каналы. Выберите канал, чтобы настроить:", {
      reply_markup: channelsKeyboard(channels),
    });
  });

  bot.command("status", async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const channels = await listChannelsByOwner(userId);
    if (channels.length === 0) {
      await ctx.reply("Нет подключённых каналов.");
      return;
    }

    const lines = channels.map((ch) => {
      const mark = ch.auto_approve ? "✅ приём вкл" : "⛔️ приём выкл";
      return `• ${ch.title ?? ch.chat_id} — ${mark}`;
    });
    await ctx.reply(`Ваши каналы (${channels.length}):\n${lines.join("\n")}`);
  });

  bot.command("stats", async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const stats = await statsByOwner(userId);
    if (stats.length === 0) {
      await ctx.reply("Нет подключённых каналов.");
      return;
    }

    const total = stats.reduce((sum, s) => sum + s.approved, 0);
    const lines = stats.map((s) => `• ${s.title ?? s.chat_id} — ${s.approved}`);
    await ctx.reply(`Принято заявок: ${total}\n${lines.join("\n")}`);
  });
}
