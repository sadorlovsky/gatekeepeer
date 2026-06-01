import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const dbPath = `/private/tmp/gatekeepeer-test-${process.pid}-${Date.now()}.sqlite`;

type DbModule = typeof import("../src/db.ts");
let db: DbModule;
let commandsModule: typeof import("../src/handlers/commands.ts");
let callbacksModule: typeof import("../src/handlers/callbacks.ts");
let joinRequestModule: typeof import("../src/handlers/joinRequest.ts");
let chatMemberModule: typeof import("../src/handlers/chatMember.ts");
let moderationModule: typeof import("../src/handlers/moderation.ts");
let heuristicsModule: typeof import("../src/moderation/heuristics.ts");
let config: typeof import("../src/config.ts").config;

function seedLegacyDb(): void {
  const legacy = new Database(dbPath, { create: true });
  try {
    legacy.run(`
      CREATE TABLE channels (
        chat_id      INTEGER PRIMARY KEY,
        title        TEXT,
        type         TEXT,
        added_by     INTEGER NOT NULL,
        auto_approve INTEGER NOT NULL DEFAULT 1,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL
      )
    `);
    legacy.run(`
      CREATE TABLE join_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    INTEGER NOT NULL,
        user_id    INTEGER NOT NULL,
        username   TEXT,
        decision   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const insertChannel = legacy.query(`
      INSERT INTO channels (chat_id, title, type, added_by, auto_approve, active, created_at)
      VALUES ($chat_id, $title, $type, $added_by, $auto_approve, $active, $created_at)
    `);
    insertChannel.run({
      $chat_id: -100,
      $title: "Owner one",
      $type: "channel",
      $added_by: 1,
      $auto_approve: 1,
      $active: 1,
      $created_at: 1_000,
    });
    insertChannel.run({
      $chat_id: -200,
      $title: "Owner two",
      $type: "channel",
      $added_by: 2,
      $auto_approve: 1,
      $active: 1,
      $created_at: 2_000,
    });

    const insertEvent = legacy.query(`
      INSERT INTO join_events (chat_id, user_id, username, decision, created_at)
      VALUES ($chat_id, $user_id, $username, $decision, $created_at)
    `);
    insertEvent.run({
      $chat_id: -100,
      $user_id: 10,
      $username: "dup",
      $decision: "approved",
      $created_at: 10_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 10,
      $username: "dup",
      $decision: "approved",
      $created_at: 10_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 11,
      $username: "unique",
      $decision: "approved",
      $created_at: 11_000,
    });
    insertEvent.run({
      $chat_id: -100,
      $user_id: 12,
      $username: "declined",
      $decision: "declined",
      $created_at: 12_000,
    });
    insertEvent.run({
      $chat_id: -200,
      $user_id: 20,
      $username: "other",
      $decision: "approved",
      $created_at: 20_000,
    });
  } finally {
    legacy.close();
  }
}

beforeAll(async () => {
  process.env.BOT_TOKEN = "test-token";
  process.env.WEBHOOK_URL = "https://example.com";
  process.env.WEBHOOK_SECRET = "test-secret-1234567890_ABCDEFGHijkl";
  process.env.DB_PATH = dbPath;

  seedLegacyDb();
  db = await import("../src/db.ts");
  commandsModule = await import("../src/handlers/commands.ts");
  callbacksModule = await import("../src/handlers/callbacks.ts");
  joinRequestModule = await import("../src/handlers/joinRequest.ts");
  chatMemberModule = await import("../src/handlers/chatMember.ts");
  moderationModule = await import("../src/handlers/moderation.ts");
  heuristicsModule = await import("../src/moderation/heuristics.ts");
  config = (await import("../src/config.ts")).config;
});

type Handler = (ctx: any) => Promise<void> | void;

function commandHarness(): { bot: any; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  return {
    bot: {
      command(name: string, handler: Handler): void {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

// Колбэков теперь несколько; harness собирает все регистрации и маршрутизирует
// callback_data к первому подходящему обработчику — как делает grammY.
function callbackHarness(): {
  bot: any;
  registrations: { pattern: RegExp; handler: Handler }[];
  match: (data: string) => { pattern: RegExp; handler: Handler } | undefined;
  dispatch: (data: string, ctx: any) => Promise<void>;
} {
  const registrations: { pattern: RegExp; handler: Handler }[] = [];
  const match = (data: string) => registrations.find((r) => r.pattern.test(data));
  return {
    bot: {
      callbackQuery(pattern: RegExp, handler: Handler): void {
        registrations.push({ pattern, handler });
      },
    },
    registrations,
    match,
    async dispatch(data: string, ctx: any): Promise<void> {
      for (const reg of registrations) {
        const m = reg.pattern.exec(data);
        if (m) {
          ctx.match = m;
          await reg.handler(ctx);
          return;
        }
      }
      throw new Error(`Нет обработчика для callback_data: ${data}`);
    },
  };
}

function eventHarness(): { bot: any; handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  return {
    bot: {
      on(name: string, handler: Handler): void {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

describe("database migrations", () => {
  test("migrates legacy schema and backfills stats after deduplication", async () => {
    expect(await db.statsByOwner(1)).toEqual([
      { chat_id: -100, title: "Owner one", approved: 2 },
    ]);
    expect(await db.statsByOwner(2)).toEqual([
      { chat_id: -200, title: "Owner two", approved: 1 },
    ]);
  });

  test("applies defaults for new columns on legacy rows", async () => {
    const channel = await db.getChannel(-100);
    expect(channel?.join_mode).toBe("approve");
    expect(channel?.welcome_pending).toBe(0);
    expect(channel?.moderation_enabled).toBe(0);
    // Legacy-каналы были зарегистрированы при наличии права приглашать; права по
    // умолчанию 1 (can_delete — оптимистично, перепроверится на следующем событии).
    expect(channel?.can_invite).toBe(1);
    expect(channel?.can_delete).toBe(1);
  });
});

describe("channel ownership", () => {
  test("does not transfer ownership when an existing channel is re-registered", async () => {
    await db.upsertChannel({
      chatId: -300,
      title: "Original",
      type: "channel",
      addedBy: 1,
    });
    await db.setAutoApprove(-300, 1, false);

    await db.upsertChannel({
      chatId: -300,
      title: "Renamed",
      type: "channel",
      addedBy: 2,
    });

    const channel = await db.getChannel(-300);
    expect(channel?.added_by).toBe(1);
    expect(channel?.title).toBe("Renamed");
    expect(channel?.auto_approve).toBe(0);
    expect(await db.setAutoApprove(-300, 2, true)).toBe(false);
    expect(await db.setAutoApprove(-300, 1, true)).toBe(true);
  });
});

describe("channel settings", () => {
  test("setJoinMode is scoped to the owner", async () => {
    await db.upsertChannel({ chatId: -650, title: "Mode own", type: "channel", addedBy: 65 });

    expect(await db.setJoinMode(-650, 99, "decline")).toBe(false);
    expect((await db.getChannel(-650))?.join_mode).toBe("approve");

    expect(await db.setJoinMode(-650, 65, "decline")).toBe(true);
    expect((await db.getChannel(-650))?.join_mode).toBe("decline");
  });

  test("setModerationEnabled is scoped to the owner", async () => {
    await db.upsertChannel({ chatId: -651, title: "Mod own", type: "channel", addedBy: 65 });

    expect(await db.setModerationEnabled(-651, 99, true)).toBe(false);
    expect((await db.getChannel(-651))?.moderation_enabled).toBe(0);

    expect(await db.setModerationEnabled(-651, 65, true)).toBe(true);
    expect((await db.getChannel(-651))?.moderation_enabled).toBe(1);
  });

  test("pending welcome is listed then delivered and cleared on /start", async () => {
    await db.upsertChannel({ chatId: -660, title: "Welcome chan", type: "channel", addedBy: 66 });
    await db.markWelcomePending(-660, true);

    expect((await db.listPendingWelcome(66)).map((c) => c.chat_id)).toContain(-660);

    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[][] = [];
    await handlers.start?.({
      chat: { type: "private" },
      from: { id: 66 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    });

    expect(replies.some((r) => String(r[0]).includes("Welcome chan"))).toBe(true);
    expect(await db.listPendingWelcome(66)).toEqual([]);
  });
});

describe("join event accounting", () => {
  test("counts repeated delivery of the same approved request only once", async () => {
    await db.upsertChannel({
      chatId: -400,
      title: "Webhook retry",
      type: "channel",
      addedBy: 1,
    });

    const event = {
      chatId: -400,
      userId: 42,
      username: "retry",
      decision: "approved" as const,
      requestedAt: 123_456,
    };
    await db.logJoin(event);
    await db.logJoin(event);

    expect(await db.statsByOwner(1)).toContainEqual({
      chat_id: -400,
      title: "Webhook retry",
      approved: 1,
    });
  });

  test("retention pruning does not change all-time approved stats", async () => {
    const before = (await db.statsByOwner(1)).find(
      (stat) => stat.chat_id === -100,
    );
    expect(before?.approved).toBe(2);

    const removed = await db.pruneJoinEvents(0);
    expect(removed).toBeGreaterThan(0);

    const after = (await db.statsByOwner(1)).find(
      (stat) => stat.chat_id === -100,
    );
    expect(after?.approved).toBe(2);
  });
});

describe("commands", () => {
  test("start and help reply with onboarding text", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[] = [];
    const ctx = {
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.start?.(ctx);
    await handlers.help?.(ctx);

    expect(replies).toHaveLength(2);
    expect(String((replies[0] as unknown[])[0])).toContain("/channels");
    expect(String((replies[1] as unknown[])[0])).toContain("/stats");
  });

  test("management commands ignore non-private chats", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[] = [];
    const ctx = {
      chat: { type: "supergroup" },
      from: { id: 1 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(replies).toEqual([]);
  });

  test("channels, status, and stats are scoped to the requesting owner", async () => {
    await db.upsertChannel({
      chatId: -500,
      title: "Owner scoped",
      type: "channel",
      addedBy: 50,
    });
    await db.upsertChannel({
      chatId: -501,
      title: "Other owner",
      type: "channel",
      addedBy: 51,
    });
    await db.logJoin({
      chatId: -500,
      userId: 5000,
      username: "owner",
      decision: "approved",
      requestedAt: 5000,
    });
    await db.logJoin({
      chatId: -501,
      userId: 5100,
      username: "other",
      decision: "approved",
      requestedAt: 5100,
    });

    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[][] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: 50 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(String(replies[0]?.[0])).toContain("Ваши каналы");
    expect(replies[0]?.[1]).toHaveProperty("reply_markup");
    expect(String(replies[1]?.[0])).toContain("Owner scoped");
    expect(String(replies[1]?.[0])).not.toContain("Other owner");
    expect(String(replies[2]?.[0])).toContain("Принято заявок: 1");
    expect(String(replies[2]?.[0])).toContain("Owner scoped");
    expect(String(replies[2]?.[0])).not.toContain("Other owner");
  });

  test("channels, status, and stats report empty state for unknown owners", async () => {
    const { bot, handlers } = commandHarness();
    commandsModule.registerCommands(bot);
    const replies: unknown[][] = [];
    const ctx = {
      chat: { type: "private" },
      from: { id: 999_999 },
      reply: async (...args: unknown[]) => {
        replies.push(args);
      },
    };

    await handlers.channels?.(ctx);
    await handlers.status?.(ctx);
    await handlers.stats?.(ctx);

    expect(String(replies[0]?.[0])).toContain("пока нет подключённых каналов");
    expect(replies[1]?.[0]).toBe("Нет подключённых каналов.");
    expect(replies[2]?.[0]).toBe("Нет подключённых каналов.");
  });
});

describe("callbacks", () => {
  test("verb patterns route correctly and reject malformed data", () => {
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);

    expect(harness.match("ch:-100")).toBeDefined();
    expect(harness.match("list")).toBeDefined();
    expect(harness.match("toggle:-100")).toBeDefined();
    expect(harness.match("mode:-100:captcha")).toBeDefined();
    expect(harness.match("mod:-100")).toBeDefined();
    expect(harness.match("cap:-100")).toBeDefined();

    expect(harness.match("ch:not-a-number")).toBeUndefined();
    expect(harness.match("toggle:not-a-number")).toBeUndefined();
    expect(harness.match("mode:-100:bogus")).toBeUndefined();
  });

  test("non-private chat is answered silently", async () => {
    await db.upsertChannel({ chatId: -600, title: "Private toggle", type: "channel", addedBy: 60 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const answers: unknown[][] = [];

    await harness.dispatch("toggle:-600", {
      chat: { type: "supergroup" },
      from: { id: 1 },
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
    });

    expect(answers).toEqual([[]]);
  });

  test("owner-scoped verbs reject channels owned by someone else", async () => {
    await db.upsertChannel({ chatId: -600, title: "Private toggle", type: "channel", addedBy: 60 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const answers: unknown[][] = [];

    await harness.dispatch("toggle:-600", {
      chat: { type: "private" },
      from: { id: 61 },
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
    });

    expect(answers).toEqual([[{ text: "Этот канал вам не принадлежит." }]]);
    expect((await db.getChannel(-600))?.auto_approve).toBe(1);
  });

  test("opening a channel renders its detail screen", async () => {
    await db.upsertChannel({ chatId: -610, title: "Detail chan", type: "channel", addedBy: 60 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const edits: unknown[][] = [];

    await harness.dispatch("ch:-610", {
      chat: { type: "private" },
      from: { id: 60 },
      answerCallbackQuery: async () => {},
      editMessageText: async (...args: unknown[]) => {
        edits.push(args);
      },
    });

    expect(String(edits[0]?.[0])).toContain("Detail chan");
    expect(edits[0]?.[1]).toHaveProperty("reply_markup");
  });

  test("toggle flips auto approve and re-renders the detail screen", async () => {
    await db.upsertChannel({ chatId: -601, title: "Toggle me", type: "channel", addedBy: 60 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const answers: unknown[][] = [];
    const edits: unknown[][] = [];

    await harness.dispatch("toggle:-601", {
      chat: { type: "private" },
      from: { id: 60 },
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
      editMessageText: async (...args: unknown[]) => {
        edits.push(args);
      },
    });

    expect((await db.getChannel(-601))?.auto_approve).toBe(0);
    expect(answers).toEqual([[{ text: "Авто-приём выключен ⛔️" }]]);
    expect(edits[0]?.[1]).toHaveProperty("reply_markup");
  });

  test("mode verb sets join_mode for the owner only", async () => {
    await db.upsertChannel({ chatId: -620, title: "Modes", type: "channel", addedBy: 62 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);

    await harness.dispatch("mode:-620:captcha", {
      chat: { type: "private" },
      from: { id: 62 },
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
    });
    expect((await db.getChannel(-620))?.join_mode).toBe("captcha");

    await harness.dispatch("mode:-620:decline", {
      chat: { type: "private" },
      from: { id: 99 },
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
    });
    expect((await db.getChannel(-620))?.join_mode).toBe("captcha"); // не сменилось
  });

  test("mod verb toggles moderation for the owner", async () => {
    await db.upsertChannel({ chatId: -630, title: "Mod toggle", type: "channel", addedBy: 63 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);

    await harness.dispatch("mod:-630", {
      chat: { type: "private" },
      from: { id: 63 },
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
    });

    expect((await db.getChannel(-630))?.moderation_enabled).toBe(1);
  });

  test("list verb returns to the channel list", async () => {
    await db.upsertChannel({ chatId: -640, title: "Back chan", type: "channel", addedBy: 64 });
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const edits: unknown[][] = [];

    await harness.dispatch("list", {
      chat: { type: "private" },
      from: { id: 64 },
      answerCallbackQuery: async () => {},
      editMessageText: async (...args: unknown[]) => {
        edits.push(args);
      },
    });

    expect(String(edits[0]?.[0])).toContain("Ваши каналы");
    expect(edits[0]?.[1]).toHaveProperty("reply_markup");
  });
});

describe("join request handler", () => {
  test("ignores unmanaged, inactive, and disabled channels", async () => {
    await db.upsertChannel({
      chatId: -700,
      title: "Disabled",
      type: "channel",
      addedBy: 70,
    });
    await db.setAutoApprove(-700, 70, false);
    await db.upsertChannel({
      chatId: -701,
      title: "Inactive",
      type: "channel",
      addedBy: 70,
    });
    await db.deactivateChannel(-701);

    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    let approvals = 0;
    const approveChatJoinRequest = async () => {
      approvals += 1;
    };

    for (const chatId of [-799, -700, -701]) {
      await handlers.chat_join_request?.({
        chatJoinRequest: {
          chat: { id: chatId },
          from: { id: 7000, username: "pending" },
          date: 7000,
        },
        approveChatJoinRequest,
      });
    }

    expect(approvals).toBe(0);
  });

  test("approves and records active auto-approve channel requests", async () => {
    await db.upsertChannel({
      chatId: -702,
      title: "Approvals",
      type: "channel",
      addedBy: 70,
    });
    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    const approvedUsers: number[] = [];

    await handlers.chat_join_request?.({
      chatJoinRequest: {
        chat: { id: -702 },
        from: { id: 7020, username: "approved" },
        date: 7020,
      },
      approveChatJoinRequest: async (userId: number) => {
        approvedUsers.push(userId);
      },
    });

    expect(approvedUsers).toEqual([7020]);
    expect(await db.statsByOwner(70)).toContainEqual({
      chat_id: -702,
      title: "Approvals",
      approved: 1,
    });
  });
});

describe("join request modes", () => {
  test("ignores requests when the bot lacks invite permission", async () => {
    // Канал подключён только под модерацию — приём заявок невозможен.
    await db.upsertChannel({
      chatId: -710,
      title: "Antispam only",
      type: "supergroup",
      addedBy: 71,
      canInvite: false,
      canDelete: true,
    });

    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    let approvals = 0;
    let declines = 0;

    await handlers.chat_join_request?.({
      chatJoinRequest: { chat: { id: -710 }, from: { id: 7100, username: "x" }, date: 7100 },
      approveChatJoinRequest: async () => {
        approvals += 1;
      },
      declineChatJoinRequest: async () => {
        declines += 1;
      },
    });

    expect(approvals).toBe(0);
    expect(declines).toBe(0);
  });

  test("decline mode declines the request and logs it as declined", async () => {
    await db.upsertChannel({ chatId: -730, title: "Decline chan", type: "channel", addedBy: 73 });
    await db.setJoinMode(-730, 73, "decline");

    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    const declined: number[] = [];
    let approvals = 0;

    await handlers.chat_join_request?.({
      chatJoinRequest: {
        chat: { id: -730 },
        from: { id: 7300, username: "bad" },
        date: 7300,
      },
      declineChatJoinRequest: async (userId: number) => {
        declined.push(userId);
      },
      approveChatJoinRequest: async () => {
        approvals += 1;
      },
    });

    expect(declined).toEqual([7300]);
    expect(approvals).toBe(0);
    const stat = (await db.statsByOwner(73)).find((s) => s.chat_id === -730);
    expect(stat?.approved ?? 0).toBe(0);
  });

  test("captcha mode DMs the requester and stores pending without approving", async () => {
    await db.upsertChannel({ chatId: -720, title: "Captcha chan", type: "channel", addedBy: 72 });
    await db.setJoinMode(-720, 72, "captcha");

    const { bot, handlers } = eventHarness();
    joinRequestModule.registerJoinRequest(bot);
    const sent: unknown[][] = [];
    let approvals = 0;

    await handlers.chat_join_request?.({
      chatJoinRequest: {
        chat: { id: -720 },
        from: { id: 7200, username: "human" },
        date: 7200,
        user_chat_id: 99200,
      },
      approveChatJoinRequest: async () => {
        approvals += 1;
      },
      api: {
        sendMessage: async (...args: unknown[]) => {
          sent.push(args);
          return { message_id: 555 };
        },
      },
    });

    expect(approvals).toBe(0);
    expect(sent[0]?.[0]).toBe(99200);
    const pending = await db.getCaptchaPending(-720, 7200);
    expect(pending?.user_chat_id).toBe(99200);
    expect(pending?.prompt_msg_id).toBe(555);
    const stat = (await db.statsByOwner(72)).find((s) => s.chat_id === -720);
    expect(stat?.approved ?? 0).toBe(0);
  });

  test("captcha callback approves once and is idempotent on a second press", async () => {
    // Опираемся на запись, созданную предыдущим тестом (chat -720, user 7200).
    const harness = callbackHarness();
    callbacksModule.registerCallbacks(harness.bot);
    const approved: number[] = [];
    const baseCtx = {
      chat: { type: "private" },
      from: { id: 7200 },
      answerCallbackQuery: async () => {},
      editMessageText: async () => {},
      api: {
        approveChatJoinRequest: async (_chatId: number, userId: number) => {
          approved.push(userId);
        },
      },
    };

    await harness.dispatch("cap:-720", { ...baseCtx });

    expect(approved).toEqual([7200]);
    expect(await db.getCaptchaPending(-720, 7200)).toBeNull();
    expect((await db.statsByOwner(72)).find((s) => s.chat_id === -720)?.approved).toBe(1);

    const answers: unknown[][] = [];
    await harness.dispatch("cap:-720", {
      ...baseCtx,
      answerCallbackQuery: async (...args: unknown[]) => {
        answers.push(args);
      },
    });

    expect(approved).toEqual([7200]); // повторного одобрения нет
    expect(answers).toEqual([[{ text: "Время вышло или уже подтверждено." }]]);
  });

  test("prunePendingCaptcha removes and returns expired rows", async () => {
    await db.addCaptchaPending({
      chatId: -740,
      userId: 7400,
      userChatId: 1,
      username: null,
      requestedAt: 1,
    });

    const removed = await db.prunePendingCaptcha(0);
    expect(removed.some((r) => r.chat_id === -740 && r.user_id === 7400)).toBe(true);
    expect(await db.getCaptchaPending(-740, 7400)).toBeNull();
  });
});

describe("heuristics helpers", () => {
  test("countEmoji counts pictographic emoji", () => {
    expect(heuristicsModule.countEmoji("plain text")).toBe(0);
    expect(heuristicsModule.countEmoji("🔥🔥🔥🔥🔥🔥 sale")).toBe(6);
  });

  test("hasMixedScripts flags Latin+Cyrillic inside a word, not separate words", () => {
    // «kупить» — латинская k в кириллическом слове (обфускация).
    expect(heuristicsModule.hasMixedScripts("kупить дёшево")).toBe(true);
    // Нормальный двуязычный текст с раздельными словами — не сигнал.
    expect(heuristicsModule.hasMixedScripts("hello мир hello")).toBe(false);
  });

  test("abnormalSpacing flags letter-spaced text", () => {
    expect(heuristicsModule.abnormalSpacing("к у п и т ь")).toBe(true);
    expect(heuristicsModule.abnormalSpacing("обычное сообщение в чате")).toBe(false);
  });

  test("shouldClassify gates on the flag and escalates on content/metadata", () => {
    const on = { moderation_enabled: 1 } as any;
    const off = { moderation_enabled: 0 } as any;

    expect(heuristicsModule.shouldClassify({ text: "visit https://t.me/scam now" }, off)).toBe(false);
    expect(heuristicsModule.shouldClassify({}, on)).toBe(false);
    expect(heuristicsModule.shouldClassify({ text: "hi" }, on)).toBe(false);
    expect(heuristicsModule.shouldClassify({ text: "just a normal message here" }, on)).toBe(false);
    expect(heuristicsModule.shouldClassify({ text: "visit https://t.me/scam now" }, on)).toBe(true);
    // Метаданные-сигналы без ссылок/упоминаний в тексте.
    expect(heuristicsModule.shouldClassify({ text: "обычный текст", forward_origin: {} }, on)).toBe(true);
    expect(
      heuristicsModule.shouldClassify(
        { text: "жми кнопку", reply_markup: { inline_keyboard: [[{}]] } },
        on,
      ),
    ).toBe(true);
    expect(heuristicsModule.shouldClassify({ text: "kупить дёшево сейчас", }, on)).toBe(true);
    // Медиа без подписи → эскалация.
    expect(heuristicsModule.shouldClassify({ photo: [{}] }, on)).toBe(true);
  });
});

describe("newcomer trust tracking", () => {
  test("getSeenCount returns 0 for unknown, bumpSeen creates then increments", async () => {
    expect(await db.getSeenCount(-9001, 42)).toBe(0);
    await db.bumpSeen(-9001, 42);
    expect(await db.getSeenCount(-9001, 42)).toBe(1);
    await db.bumpSeen(-9001, 42);
    expect(await db.getSeenCount(-9001, 42)).toBe(2);
  });

  test("pruneModerationSeen removes rows and returns the count", async () => {
    await db.bumpSeen(-9002, 1);
    await db.bumpSeen(-9002, 2);
    const removed = await db.pruneModerationSeen(0);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await db.getSeenCount(-9002, 1)).toBe(0);
  });
});

describe("spam moderation", () => {
  // checkCas во всех тестах стабится — иначе реальная проверка пойдёт в сеть.
  const noCas = async () => false;

  test("deletes a message only when the classifier flags it as spam", async () => {
    await db.upsertChannel({ chatId: -750, title: "Mod chan", type: "supergroup", addedBy: 75 });
    await db.setModerationEnabled(-750, 75, true);

    const spamRun = eventHarness();
    moderationModule.registerModeration(spamRun.bot, {
      classify: async () => ({ spam: true, reason: "тест" }),
      checkCas: noCas,
    });
    let deletedSpam = 0;
    await spamRun.handlers.message?.({
      message: { text: "spam https://x.example", message_id: 1, from: { id: 7501 } },
      chat: { id: -750 },
      deleteMessage: async () => {
        deletedSpam += 1;
      },
    });
    expect(deletedSpam).toBe(1);
    // Спам не продвигает доверие.
    expect(await db.getSeenCount(-750, 7501)).toBe(0);

    const hamRun = eventHarness();
    moderationModule.registerModeration(hamRun.bot, {
      classify: async () => ({ spam: false, reason: "ok" }),
      checkCas: noCas,
    });
    let deletedHam = 0;
    await hamRun.handlers.message?.({
      message: { text: "spam https://x.example", message_id: 2, from: { id: 7502 } },
      chat: { id: -750 },
      deleteMessage: async () => {
        deletedHam += 1;
      },
    });
    expect(deletedHam).toBe(0);
    // Ham продвигает доверие.
    expect(await db.getSeenCount(-750, 7502)).toBe(1);
  });

  test("CAS hit deletes before the classifier runs", async () => {
    await db.upsertChannel({ chatId: -753, title: "CAS chan", type: "supergroup", addedBy: 75 });
    await db.setModerationEnabled(-753, 75, true);

    const run = eventHarness();
    let classified = 0;
    moderationModule.registerModeration(run.bot, {
      classify: async () => {
        classified += 1;
        return { spam: false, reason: "не должно вызваться" };
      },
      checkCas: async () => true,
    });
    let deleted = 0;
    await run.handlers.message?.({
      message: { text: "обычное сообщение", message_id: 5, from: { id: 7531 } },
      chat: { id: -753 },
      deleteMessage: async () => {
        deleted += 1;
      },
    });
    expect(deleted).toBe(1);
    expect(classified).toBe(0);
    // CAS-попадание не продвигает доверие.
    expect(await db.getSeenCount(-753, 7531)).toBe(0);
  });

  test("trusted newcomer skips checks after N clean messages", async () => {
    await db.upsertChannel({ chatId: -754, title: "Trust chan", type: "supergroup", addedBy: 75 });
    await db.setModerationEnabled(-754, 75, true);
    const N = config.moderation.firstMessages;

    const run = eventHarness();
    let classified = 0;
    let casCalls = 0;
    moderationModule.registerModeration(run.bot, {
      classify: async () => {
        classified += 1;
        return { spam: false, reason: "ok" };
      },
      checkCas: async () => {
        casCalls += 1;
        return false;
      },
    });
    // N чистых (не подозрительных) сообщений → доверие достигнуто.
    for (let i = 0; i < N; i++) {
      await run.handlers.message?.({
        message: { text: "просто болтаю о погоде", message_id: 100 + i, from: { id: 7541 } },
        chat: { id: -754 },
        deleteMessage: async () => {},
      });
    }
    expect(await db.getSeenCount(-754, 7541)).toBe(N);

    const casBefore = casCalls;
    // (N+1)-е сообщение — даже подозрительное — не доходит до CAS/LLM.
    await run.handlers.message?.({
      message: { text: "купи сейчас https://t.me/scam", message_id: 999, from: { id: 7541 } },
      chat: { id: -754 },
      deleteMessage: async () => {},
    });
    expect(casCalls).toBe(casBefore);
    expect(classified).toBe(0);
  });

  test("channel_post takes the short path (no CAS, no seen tracking)", async () => {
    await db.upsertChannel({ chatId: -755, title: "Chan post", type: "channel", addedBy: 75 });
    await db.setModerationEnabled(-755, 75, true);

    const run = eventHarness();
    let casCalls = 0;
    moderationModule.registerModeration(run.bot, {
      classify: async () => ({ spam: true, reason: "тест" }),
      checkCas: async () => {
        casCalls += 1;
        return false;
      },
    });
    let deleted = 0;
    await run.handlers.channel_post?.({
      channelPost: { text: "spam https://x.example", message_id: 6 },
      chat: { id: -755 },
      deleteMessage: async () => {
        deleted += 1;
      },
    });
    expect(deleted).toBe(1);
    expect(casCalls).toBe(0);
  });

  test("does not classify when moderation is disabled for the channel", async () => {
    await db.upsertChannel({ chatId: -751, title: "Mod off", type: "supergroup", addedBy: 75 });

    const run = eventHarness();
    let classified = 0;
    moderationModule.registerModeration(run.bot, {
      classify: async () => {
        classified += 1;
        return { spam: true, reason: "не должно вызваться" };
      },
      checkCas: noCas,
    });
    let deleted = 0;
    await run.handlers.message?.({
      message: { text: "spam https://x.example", message_id: 3, from: { id: 7511 } },
      chat: { id: -751 },
      deleteMessage: async () => {
        deleted += 1;
      },
    });

    expect(classified).toBe(0);
    expect(deleted).toBe(0);
  });

  test("does not classify when the bot lacks delete permission", async () => {
    // Канал с включённой модерацией, но бот не может удалять сообщения.
    await db.upsertChannel({
      chatId: -752,
      title: "No delete right",
      type: "supergroup",
      addedBy: 75,
      canInvite: false,
      canDelete: false,
    });
    await db.setModerationEnabled(-752, 75, true);

    const run = eventHarness();
    let classified = 0;
    moderationModule.registerModeration(run.bot, {
      classify: async () => {
        classified += 1;
        return { spam: true, reason: "не должно вызваться" };
      },
      checkCas: noCas,
    });
    let deleted = 0;
    await run.handlers.message?.({
      message: { text: "spam https://x.example", message_id: 4, from: { id: 7521 } },
      chat: { id: -752 },
      deleteMessage: async () => {
        deleted += 1;
      },
    });

    expect(classified).toBe(0);
    expect(deleted).toBe(0);
  });
});

describe("chat member handler", () => {
  test("registers a new channel to the chat creator and notifies that owner", async () => {
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);
    const sentMessages: unknown[][] = [];

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -800, type: "channel", title: "Creator owned" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => [
          { status: "administrator", user: { id: 801 } },
          { status: "creator", user: { id: 800 } },
        ],
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    });

    expect((await db.getChannel(-800))?.added_by).toBe(800);
    expect(sentMessages[0]?.[0]).toBe(800);
    expect(String(sentMessages[0]?.[1])).toContain("Creator owned");
  });

  test("registers a moderation-only channel when the bot can delete but not invite", async () => {
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);
    const sentMessages: unknown[][] = [];

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -815, type: "supergroup", title: "Antispam only" },
        new_chat_member: {
          status: "administrator",
          can_invite_users: false,
          can_delete_messages: true,
        },
      },
      api: {
        getChatAdministrators: async () => [{ status: "creator", user: { id: 8150 } }],
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    });

    const channel = await db.getChannel(-815);
    expect(channel?.active).toBe(1);
    expect(channel?.added_by).toBe(8150);
    expect(channel?.can_invite).toBe(0);
    expect(channel?.can_delete).toBe(1);
    // Онбординг-DM не обещает приём заявок, только модерацию.
    expect(String(sentMessages[0]?.[1])).toContain("модерация");
    expect(String(sentMessages[0]?.[1])).not.toContain("приём заявок");
  });

  test("marks welcome pending when the first-registration DM fails", async () => {
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -810, type: "channel", title: "No DM yet" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => [{ status: "creator", user: { id: 8100 } }],
        sendMessage: async () => {
          throw new Error("owner has not started the bot");
        },
      },
    });

    expect((await db.getChannel(-810))?.welcome_pending).toBe(1);
  });

  test("reactivates an existing channel without transferring owner or sending duplicate DM", async () => {
    await db.upsertChannel({
      chatId: -801,
      title: "Existing",
      type: "channel",
      addedBy: 810,
    });
    await db.deactivateChannel(-801);
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);
    let adminFetches = 0;
    let sentMessages = 0;

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -801, type: "channel", title: "Existing renamed" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => {
          adminFetches += 1;
          return [{ status: "creator", user: { id: 999 } }];
        },
        sendMessage: async () => {
          sentMessages += 1;
        },
      },
    });

    const channel = await db.getChannel(-801);
    expect(channel?.active).toBe(1);
    expect(channel?.added_by).toBe(810);
    expect(channel?.title).toBe("Existing renamed");
    expect(adminFetches).toBe(0);
    expect(sentMessages).toBe(0);
  });

  test("skips unsupported chat types and deactivates on permission loss", async () => {
    await db.upsertChannel({
      chatId: -802,
      title: "Permission loss",
      type: "channel",
      addedBy: 820,
    });
    const { bot, handlers } = eventHarness();
    chatMemberModule.registerChatMember(bot);

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -803, type: "group", title: "Plain group" },
        new_chat_member: { status: "administrator", can_invite_users: true },
      },
      api: {
        getChatAdministrators: async () => {
          throw new Error("should not fetch admins for unsupported chat type");
        },
      },
    });

    expect(await db.getChannel(-803)).toBeNull();

    await handlers.my_chat_member?.({
      myChatMember: {
        chat: { id: -802, type: "channel", title: "Permission loss" },
        new_chat_member: { status: "administrator", can_invite_users: false },
      },
    });

    expect((await db.getChannel(-802))?.active).toBe(0);
  });
});
