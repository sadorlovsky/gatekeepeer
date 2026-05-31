// Авто-регистрация канала: реагируем на изменение статуса самого бота.
// Стал админом с правом приглашать → регистрируем канал на владельца (создателя
// канала) и пишем ему в личку. Понизили / убрали → помечаем канал неактивным.

import type { Bot, Context } from "grammy";
import { deactivateChannel, getChannel, markWelcomePending, upsertChannel } from "../db.ts";

export function registerChatMember(bot: Bot): void {
  bot.on("my_chat_member", async (ctx: Context) => {
    const upd = ctx.myChatMember;
    if (!upd) return;

    const { chat, new_chat_member: member } = upd;

    // Управляем только каналами и супергруппами (там есть заявки на вступление).
    if (chat.type !== "channel" && chat.type !== "supergroup") return;

    const isAdminWithInvite =
      member.status === "administrator" && member.can_invite_users === true;

    if (isAdminWithInvite) {
      const existing = await getChannel(chat.id);

      // Владелец — создатель канала (creator), а не тот, кто добавил бота:
      // иначе любой со-админ с правом назначать админов мог бы первым застолбить
      // канал. Для уже известного канала владельца не пересчитываем (он
      // зафиксирован) — заодно не зависим от Telegram на пути реактивации.
      let ownerId: number;
      if (existing) {
        ownerId = existing.added_by;
      } else {
        try {
          const admins = await ctx.api.getChatAdministrators(chat.id);
          const creator = admins.find((a) => a.status === "creator");
          if (!creator) {
            console.error(`Не найден создатель канала chat=${chat.id}, регистрация пропущена`);
            return;
          }
          ownerId = creator.user.id;
        } catch (err) {
          console.error(`Не удалось получить админов канала chat=${chat.id}:`, err);
          return;
        }
      }

      // Каналы и супергруппы всегда имеют title.
      await upsertChannel({
        chatId: chat.id,
        title: chat.title,
        type: chat.type,
        addedBy: ownerId,
      });

      // Уведомляем владельца только при первой регистрации, чтобы не слать
      // «подключён» повторно при каждом изменении прав бота.
      if (!existing) {
        const title = chat.title;
        try {
          await ctx.api.sendMessage(
            ownerId,
            `✅ Канал «${title}» подключён.\n` +
              `Авто-приём заявок включён. Управление — /channels.`,
          );
        } catch {
          // Владелец ещё не запускал бота в личке — DM невозможен. Откладываем
          // приветствие: доставим его на /start (см. handlers/commands.ts).
          await markWelcomePending(chat.id, true);
        }
      }
      return;
    }

    // Бот больше не админ с нужными правами (понизили / kicked / left).
    if (member.status === "left" || member.status === "kicked" || member.status === "member") {
      await deactivateChannel(chat.id);
    } else if (member.status === "administrator" && member.can_invite_users !== true) {
      // Остался админом, но без права приглашать — одобрять заявки не сможем.
      await deactivateChannel(chat.id);
    }
  });
}
