import {
  type OmnigentClientConfig,
  omnigentClientConfigFromEnv,
  omnigentClientFor,
  searchOmnigentFamily,
} from "@aiden/adapters";
import type { Actor, MessageBlock, SearchHit } from "@aiden/contracts";
import { extractLinksFromText, matchesSearchQuery, snippetAroundMatch } from "@aiden/core";
import { Prisma, type PrismaClient } from "@aiden/db";

const SEARCH_LIMIT = 25;
/** Cap name matches so content hits (messages/files/links/routines) keep most of the budget. */
const CONVERSATION_HIT_LIMIT = 5;

async function findArtifactMessages(
  prisma: PrismaClient,
  actor: Actor,
  artifacts: Array<{ id: string; targetId: string }>,
  target: "bot" | "group",
): Promise<Map<string, { id: string; seq: number }>> {
  if (artifacts.length === 0) return new Map();
  const targetColumn = target === "bot" ? Prisma.sql`t."botId"` : Prisma.sql`t."groupId"`;
  const candidates = Prisma.join(
    artifacts.map(({ id, targetId }) => Prisma.sql`(${id}, ${targetId})`),
  );
  const rows = await prisma.$queryRaw<Array<{ artifactId: string; id: string; seq: number }>>(
    Prisma.sql`
      SELECT candidate."artifactId", message.id, message.seq
      FROM (VALUES ${candidates}) AS candidate("artifactId", "targetId")
      CROSS JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE t."spaceId" = ${actor.spaceId}
          AND t."userId" = ${actor.userId}
          AND ${targetColumn} = candidate."targetId"
          AND m.blocks::text ILIKE ('%' || candidate."artifactId" || '%')
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) message
    `,
  );
  return new Map(rows.map(({ artifactId, id, seq }) => [artifactId, { id, seq }]));
}

export async function querySpaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
  /** When the engine is connected, a Muse's Conversation and side chats are searched there (its
   * messages live in the engine's transcript), not in Nova's thread rows. */
  engine?: { client: OmnigentClientConfig; email: string },
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];

  const conversationHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];
  const seen = new Set<string>();

  function pushInto(bucket: SearchHit[], hit: SearchHit, limit: number) {
    const key = [
      hit.kind,
      hit.botId ?? "",
      hit.groupId ?? "",
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || bucket.length >= limit) return;
    seen.add(key);
    bucket.push(hit);
  }

  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
      ],
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const bot of bots) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        botId: bot.id,
        botName: bot.name,
        title: bot.name,
        snippet: bot.title || bot.description || bot.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: { contains: query, mode: "insensitive" },
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const group of groups) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        groupId: group.id,
        groupName: group.name,
        title: group.name,
        snippet: group.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const contentBudget = Math.max(0, SEARCH_LIMIT - conversationHits.length);

  const artifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: null,
      botId: { not: null },
      name: { contains: query, mode: "insensitive" },
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const botArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    artifacts.flatMap((artifact) =>
      artifact.botId && artifact.bot ? [{ id: artifact.id, targetId: artifact.botId }] : [],
    ),
    "bot",
  );
  for (const artifact of artifacts) {
    if (!artifact.botId || !artifact.bot) continue;
    const message = botArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        botId: artifact.botId,
        botName: artifact.bot.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: { not: null },
      name: { contains: query, mode: "insensitive" },
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const groupArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    groupArtifacts.flatMap((artifact) =>
      artifact.groupId && artifact.group ? [{ id: artifact.id, targetId: artifact.groupId }] : [],
    ),
    "group",
  );
  for (const artifact of groupArtifacts) {
    if (!artifact.groupId || !artifact.group) continue;
    const message = groupArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        groupId: artifact.groupId,
        groupName: artifact.group.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  const routines = await prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { prompt: { contains: query, mode: "insensitive" } },
      ],
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    pushInto(
      contentHits,
      {
        kind: "routine",
        botId: routine.botId,
        botName: routine.bot.name,
        title: routine.name,
        snippet: snippetAroundMatch(routine.prompt, query),
        routineId: routine.id,
      },
      contentBudget,
    );
  }

  const pattern = `%${query}%`;
  const messageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      botId: string;
      botName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, b.id AS "botId", b.name AS "botName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN bots b ON b.id = t."botId"
    WHERE t."spaceId" = ${actor.spaceId}
      AND t."userId" = ${actor.userId}
      AND b."archivedAt" IS NULL
      AND m.blocks::text ILIKE ${pattern}
      ${engine ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM omnigent_sessions os WHERE os."botId" = b.id)` : Prisma.empty}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of messageRows) {
    pushMessageHits(row.blocks as MessageBlock[], {
      botId: row.botId,
      botName: row.botName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  if (engine) {
    const sessions = await prisma.omnigentSession.findMany({
      where: { bot: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null } },
      select: { omnigentSessionId: true, bot: { select: { id: true, name: true } } },
    });
    const found = await Promise.all(
      sessions.map((session) =>
        searchOmnigentFamily(engine.client, engine.email, session.omnigentSessionId, query).then(
          (messages) => ({ bot: session.bot, root: session.omnigentSessionId, messages }),
          // One Muse's engine failing must not take the whole search down.
          () => ({ bot: session.bot, root: session.omnigentSessionId, messages: [] }),
        ),
      ),
    );
    for (const { bot, root, messages } of found) {
      for (const message of messages) {
        pushInto(
          contentHits,
          {
            kind: "message",
            botId: bot.id,
            botName: bot.name,
            title: bot.name,
            snippet: snippetAroundMatch(message.text, query),
            messageId: message.id,
            // A hit in a side chat opens that chat; the Conversation has no chat id.
            ...(message.sessionId === root ? {} : { chatId: message.sessionId }),
            seq: 0,
          },
          contentBudget,
        );
      }
    }
  }

  const groupMessageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      groupId: string;
      groupName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, g.id AS "groupId", g.name AS "groupName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN chat_groups g ON g.id = t."groupId"
    WHERE t."spaceId" = ${actor.spaceId}
      AND t."userId" = ${actor.userId}
      AND t."groupId" IS NOT NULL
      AND m.blocks::text ILIKE ${pattern}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of groupMessageRows) {
    pushMessageHits(row.blocks as MessageBlock[], {
      groupId: row.groupId,
      groupName: row.groupName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  return [...conversationHits, ...contentHits].slice(0, SEARCH_LIMIT);
}

function pushMessageHits(
  blocks: MessageBlock[],
  ctx: {
    botId?: string;
    botName?: string;
    groupId?: string;
    groupName?: string;
    messageId: string;
    seq: number;
    query: string;
    push: (hit: SearchHit) => void;
  },
) {
  // Discriminate on groupId (not name): empty group names must still target the group.
  const destination = ctx.groupId
    ? { groupId: ctx.groupId, groupName: ctx.groupName ?? "" }
    : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupId ? (ctx.groupName ?? "") : (ctx.botName ?? "");
  let messageHit = false;
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    const text = block.text;
    if (matchesSearchQuery(ctx.query, text)) {
      ctx.push({
        kind: "message",
        ...destination,
        title,
        snippet: snippetAroundMatch(text, ctx.query),
        messageId: ctx.messageId,
        seq: ctx.seq,
      });
      messageHit = true;
    }
    for (const url of extractLinksFromText(text)) {
      if (matchesSearchQuery(ctx.query, url)) {
        ctx.push({
          kind: "link",
          ...destination,
          title: url,
          snippet: snippetAroundMatch(text, ctx.query),
          messageId: ctx.messageId,
          seq: ctx.seq,
          url,
        });
      }
    }
  }
  if (!messageHit && matchesSearchQuery(ctx.query, JSON.stringify(blocks))) {
    ctx.push({
      kind: "message",
      ...destination,
      title,
      snippet: ctx.query,
      messageId: ctx.messageId,
      seq: ctx.seq,
    });
  }
}

/** The engine connection search reads a Muse's Conversation through, or `undefined` when the
 * engine is not configured (search then stays on Nova's own rows). */
export async function engineSearch(
  prisma: PrismaClient,
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ client: OmnigentClientConfig; email: string } | undefined> {
  const connection = omnigentClientConfigFromEnv(env);
  if (!connection) return undefined;
  const client = omnigentClientFor(connection, actor.spaceId);
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true },
  });
  return user ? { client, email: user.email } : undefined;
}
