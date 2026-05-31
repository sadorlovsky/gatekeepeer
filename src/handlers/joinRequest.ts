// Обработка заявок на вступление. Если канал активен и приём включён
// (auto_approve = 1), действуем по join_mode:
//   approve  — молча одобряем (поведение по умолчанию, как раньше);
//   decline  — молча отклоняем;
//   captcha  — пишем заявителю в личку и ждём подтверждения «я человек».
// Если приём выключен или канал не под управлением — заявка остаётся висеть.

import type { Bot, Context } from "grammy";
import {
  addCaptchaPending,
  getChannel,
  logJoin,
  setCaptchaPromptMsgId,
  type Channel,
} from "../db.ts";
import { captchaKeyboard } from "../keyboards.ts";

export function registerJoinRequest(bot: Bot): void {
  bot.on("chat_join_request", async (ctx: Context) => {
    const req = ctx.chatJoinRequest;
    if (!req) return;

    const channel = await getChannel(req.chat.id);
    if (!channel || channel.active === 0 || channel.auto_approve === 0) {
      // Канал не под управлением или приём выключен — оставляем заявку висеть.
      return;
    }

    switch (channel.join_mode) {
      case "decline":
        try {
          await ctx.declineChatJoinRequest(req.from.id);
          await logJoin({
            chatId: req.chat.id,
            userId: req.from.id,
            username: req.from.username ?? null,
            decision: "declined",
            requestedAt: req.date,
          });
        } catch (err) {
          console.error(
            `Не удалось отклонить заявку user=${req.from.id} chat=${req.chat.id}:`,
            err,
          );
        }
        return;

      case "captcha":
        await sendCaptcha(ctx, req, channel);
        return;

      case "approve":
      default:
        try {
          await ctx.approveChatJoinRequest(req.from.id);
          await logJoin({
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
        return;
    }
  });
}

/**
 * Шлёт капчу заявителю через user_chat_id (личка доступна боту 5 минут после
 * подачи заявки, даже если заявитель не запускал бота). Подтверждение обрабатывает
 * капча-колбэк в handlers/callbacks.ts. Заявку пока не одобряем и не логируем.
 */
async function sendCaptcha(
  ctx: Context,
  req: NonNullable<Context["chatJoinRequest"]>,
  channel: Channel,
): Promise<void> {
  const userChatId = req.user_chat_id;
  if (userChatId === undefined) {
    // Без user_chat_id написать заявителю нельзя — оставляем заявку висеть.
    console.error(`Капча: нет user_chat_id user=${req.from.id} chat=${req.chat.id}`);
    return;
  }

  await addCaptchaPending({
    chatId: req.chat.id,
    userId: req.from.id,
    userChatId,
    username: req.from.username ?? null,
    requestedAt: req.date,
  });

  try {
    const sent = await ctx.api.sendMessage(
      userChatId,
      `Подтвердите, что вы человек, чтобы вступить в «${channel.title ?? "канал"}».\n` +
        `Нажмите кнопку ниже.`,
      { reply_markup: captchaKeyboard(req.chat.id) },
    );
    await setCaptchaPromptMsgId(req.chat.id, req.from.id, sent.message_id);
  } catch (err) {
    // Заявитель заблокировал бота или личка недоступна — заявка остаётся висеть,
    // запись капчи удалится по таймауту (см. src/index.ts).
    console.error(`Капча: не удалось отправить DM user=${req.from.id}:`, err);
  }
}
