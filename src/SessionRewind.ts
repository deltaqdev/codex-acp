import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {z} from "zod";
import type {UpdateSessionEvent} from "./ACPSessionConnection";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {SessionState} from "./CodexAcpServer";
import type {ServerNotification} from "./app-server";
import type {ThreadItem, Turn} from "./app-server/v2";
import {findTurnIndex} from "./SessionFork";
import {toTokenCount} from "./TokenCount";

/** Rexa's name for ACP RFD #1321 `session/rewind`, see `docs/session-rewind.md`. */
export const SESSION_REWIND_METHOD = "_sh.rexa/session/rewind";
/** Advertised in the `_meta` of the initialize response's agent capabilities, on v1 and v2. */
export const SESSION_REWIND_CAPABILITY_KEY = "sh.rexa/sessionRewind";

export const sessionRewindParamsParser = z.object({
    sessionId: z.string().min(1),
    toMessageId: z.string().min(1),
}).passthrough();

export type SessionRewindRequest = {
    sessionId: string;
    toMessageId: string;
};

export type SessionRewindResponse = {
    /** The last message kept. A target inside a turn keeps that whole turn, so this can follow `toMessageId`. */
    lastMessageId: string;
};

export type SessionRewindDependencies = {
    codexClient: Pick<CodexAppServerClient, "threadReadWithHistory" | "threadRevert">;
    /** A user message carries another id on v1 than on v2, see `CodexAcpServer.createUserMessageUpdates`. */
    protocolVersion: 1 | 2;
    /** Runs `thread/revert`, during which Codex reloads the thread. */
    whileReloading(revert: () => Promise<void>): Promise<void>;
    /** Runs after `thread/revert` succeeded, to bring the session's own state in line with the thread. */
    reverted(turns: RewoundTurns): Promise<void>;
};

/** The turn ids a rewind kept and discarded, oldest first. */
export type RewoundTurns = {kept: string[]; discarded: string[]};

type RewindWindow = Pick<SessionState, "sessionId" | "reloadingForRewind">;

export function turnRunningError(sessionId: string): RequestError {
    return RequestError.invalidRequest(
        {reason: "turn_running", sessionId},
        `Session ${sessionId} has a turn running; rewind it once the turn ends`,
    );
}

/**
 * Keeps the history up to the turn holding `toMessageId` and discards every later turn, in place, through the
 * app-server's `thread/revert`. Codex reverts whole turns, so a message inside a turn keeps the rest of that turn.
 */
export async function rewindSession(
    request: SessionRewindRequest,
    dependencies: SessionRewindDependencies,
): Promise<SessionRewindResponse> {
    const {sessionId, toMessageId} = request;
    const history = await dependencies.codexClient.threadReadWithHistory(sessionId);
    // `thread/revert` shuts the thread down first, which would end a running turn.
    if (history.thread.status.type === "active") throw turnRunningError(sessionId);
    const turns = history.thread.turns;
    const {protocolVersion} = dependencies;
    const keptTurnIndex = findTurnIndex(turns, item => sentMessageId(item, protocolVersion) === toMessageId);
    if (keptTurnIndex < 0) {
        throw new RequestError(-32002, `Message ${toMessageId} was not found in session ${sessionId}`, {
            reason: "unknown_message_id",
            sessionId,
            messageId: toMessageId,
        });
    }
    const lastMessageId = lastMessageIdOf(turns[keptTurnIndex]!, protocolVersion) ?? toMessageId;
    const nextTurn = turns[keptTurnIndex + 1];
    if (nextTurn === undefined) return {lastMessageId};
    if (history.thread.historyMode !== "paginated") {
        // Codex reverts only paginated threads; older threads keep the legacy rollout format.
        throw RequestError.invalidRequest(
            {reason: "unsupported_history", sessionId},
            `Session ${sessionId} uses legacy history, which Codex cannot rewind`,
        );
    }
    await dependencies.whileReloading(async () => {
        await dependencies.codexClient.threadRevert({threadId: sessionId, beforeTurnId: nextTurn.id});
    });
    await dependencies.reverted({
        kept: turns.slice(0, keptTurnIndex + 1).map(turn => turn.id),
        discarded: turns.slice(keptTurnIndex + 1).map(turn => turn.id),
    });
    return {lastMessageId};
}

/**
 * Whether the reload of a rewind caused `event`: the client never sees it. Only the session's own thread counts,
 * and a turn Codex starts on it ends the window, so nothing a turn sends is dropped. Call it in the session's
 * notification order.
 */
export function isRewindReloadNotification(sessionState: RewindWindow, event: ServerNotification): boolean {
    if (!sessionState.reloadingForRewind || threadIdOf(event) !== sessionState.sessionId) return false;
    if (startsTurn(event)) {
        sessionState.reloadingForRewind = false;
        return false;
    }
    return true;
}

/** Whether `event` is a status change of the reload of a rewind, which `thread/reverted` follows with the final one. */
export function isRewindReloadStatus(
    sessionOf: (threadId: string) => RewindWindow | undefined,
    event: ServerNotification,
): boolean {
    const threadId = threadIdOf(event);
    if (typeof threadId !== "string" || !sessionOf(threadId)?.reloadingForRewind) return false;
    return event.method === "thread/closed" || (event.method === "thread/status/changed" && !startsTurn(event));
}

/**
 * Restores the context usage Codex reported for the newest kept turn and returns the update that tells the client;
 * null when no kept turn reported one to this process. Forgets the usage of the discarded turns.
 */
export function restoreContextUsage(
    sessionState: Pick<SessionState, "turnTokenUsage" | "lastTokenUsage" | "totalTokenUsage" | "modelContextWindow">,
    turns: RewoundTurns,
): UpdateSessionEvent | null {
    for (const turnId of turns.discarded) sessionState.turnTokenUsage?.delete(turnId);
    for (const turnId of [...turns.kept].reverse()) {
        const usage = sessionState.turnTokenUsage?.get(turnId);
        if (usage === undefined) continue;
        sessionState.lastTokenUsage = toTokenCount(usage.last);
        sessionState.totalTokenUsage = toTokenCount(usage.total);
        sessionState.modelContextWindow = usage.modelContextWindow;
        const size = usage.modelContextWindow;
        return size === null || size <= 0
            ? null
            : {sessionUpdate: "usage_update", used: sessionState.lastTokenUsage.totalTokens, size};
    }
    return null;
}

function startsTurn(event: ServerNotification): boolean {
    return event.method === "turn/started"
        || (event.method === "thread/status/changed" && event.params.status.type === "active");
}

function threadIdOf(event: ServerNotification): unknown {
    return (event.params as {threadId?: unknown} | undefined)?.threadId;
}

/** The id a message chunk of `protocolVersion` carried for this item, see `CodexAcpServer.createHistoryUpdates`. */
function sentMessageId(item: ThreadItem, protocolVersion: 1 | 2): string | null {
    switch (item.type) {
        case "userMessage":
            return protocolVersion === 2 ? item.clientId ?? item.id : item.id;
        case "agentMessage":
        case "reasoning":
            return item.id;
        case "enteredReviewMode":
        case "exitedReviewMode":
            // v1 sends these without an id.
            return protocolVersion === 2 ? item.id : null;
        default:
            return null;
    }
}

function lastMessageIdOf(turn: Turn, protocolVersion: 1 | 2): string | null {
    for (let index = turn.items.length - 1; index >= 0; index--) {
        const messageId = sentMessageId(turn.items[index]!, protocolVersion);
        if (messageId !== null) return messageId;
    }
    return null;
}
