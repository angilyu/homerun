import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineEvent } from "../engine";

const MAX_FINAL_CHARS = 1_000_000;

interface Pending {
  apiId: string;
  text: string;
  model?: string;
  parent?: string;
}

/**
 * SDK messages → engine events (plan §3.4). Pure apart from its own state; no timers.
 *
 * The SDK sends one `assistant` frame per content block, all sharing the API `message.id`. Text
 * blocks of one message are joined into one `message` event, emitted when the message ends
 * (`message_stop`), when anything else happens in between (a tool_use block, a user frame, a
 * result, a new message) or when the driver asks (`flush`, before it records a tool call). Text
 * that arrives after such a flush gets a new id, `<id>:2`, so each final is written once. A
 * tool-only message produces no `message` event.
 */
export class Translator {
  private pending: Pending | null = null;
  private segments = new Map<string, number>();
  private streamingApiId: string | null = null;
  private streamingParent: string | undefined;

  private emitId(apiId: string): string {
    const n = this.segments.get(apiId) ?? 1;
    return n === 1 ? apiId : `${apiId}:${n}`;
  }

  /** Emit the pending text as a final message, if any. */
  flush(): EngineEvent[] {
    const p = this.pending;
    this.pending = null;
    if (!p || p.text.length === 0) return [];
    const id = this.emitId(p.apiId);
    this.segments.set(p.apiId, (this.segments.get(p.apiId) ?? 1) + 1);
    return [
      {
        type: "message",
        messageId: id,
        text: p.text.length > MAX_FINAL_CHARS ? p.text.slice(0, MAX_FINAL_CHARS) : p.text,
        ...(p.model ? { model: p.model } : {}),
        ...(p.parent ? { parentToolCallId: p.parent } : {}),
      },
    ];
  }

  push(m: SDKMessage, now = Date.now()): EngineEvent[] {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          return [
            {
              type: "session",
              sessionId: m.session_id,
              tools: m.tools,
              mcpServers: m.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
              skills: m.skills ?? [],
              plugins: (m.plugins ?? []).map((p) => p.name),
              model: m.model,
            },
          ];
        }
        if (m.subtype === "api_retry") return [{ type: "status", detail: "retrying_model", retryAt: now + Math.max(0, m.retry_delay_ms) }];
        return [];

      case "rate_limit_event": {
        const info = m.rate_limit_info;
        if (info.status !== "rejected") return [];
        return [{ type: "status", detail: "rate_limited", ...(info.resetsAt ? { retryAt: Math.round(info.resetsAt * 1000) } : {}) }];
      }

      case "stream_event": {
        const ev = m.event;
        const out: EngineEvent[] = [];
        if (ev.type === "message_start") {
          if (this.pending && this.pending.apiId !== ev.message.id) out.push(...this.flush());
          this.streamingApiId = ev.message.id;
          this.streamingParent = m.parent_tool_use_id ?? undefined;
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && this.streamingApiId) {
          if (ev.delta.text) out.push({ type: "delta", messageId: this.emitId(this.streamingApiId), text: ev.delta.text });
        } else if (ev.type === "message_stop") {
          if (this.pending && this.pending.apiId === this.streamingApiId) out.push(...this.flush());
          this.streamingApiId = null;
        }
        return out;
      }

      case "assistant": {
        const msg = m.message;
        const out: EngineEvent[] = [];
        if (this.pending && this.pending.apiId !== msg.id) out.push(...this.flush());
        for (const block of msg.content) {
          if (block.type === "text") {
            if (!this.pending) {
              this.pending = { apiId: msg.id, text: "", model: msg.model, parent: m.parent_tool_use_id ?? this.streamingParent };
            }
            this.pending.text += block.text;
          } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            out.push(...this.flush());
          }
        }
        return out;
      }

      case "user": {
        const out = this.flush();
        const content = m.message.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "tool_result") {
              out.push({ type: "tool_result_seen", toolCallId: b.tool_use_id, isError: b.is_error === true, content: b.content ?? null });
            }
          }
        }
        return out;
      }

      case "result": {
        const out = this.flush();
        const consumed = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : null);
        out.push({
          type: "result",
          ok: m.subtype === "success" && !m.is_error,
          subtype: m.subtype === "success" && m.is_error ? "error_api" : m.subtype,
          totalCostUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          consumed,
          queuedTurnCount: typeof m.queued_turn_count === "number" ? m.queued_turn_count : null,
          errors: m.subtype === "success" ? (m.is_error ? [m.result] : []) : (m.errors ?? []),
          ...(m.subtype === "success" && m.structured_output !== undefined ? { structuredOutput: m.structured_output } : {}),
          ...(m.subtype === "success" && typeof m.result === "string" ? { text: m.result } : {}),
          ...(m.subtype === "success" && m.terminal_reason === "tool_deferred" && m.deferred_tool_use
            ? { deferred: { toolCallId: m.deferred_tool_use.id, tool: m.deferred_tool_use.name } }
            : {}),
        });
        return out;
      }

      default:
        return [];
    }
  }
}
