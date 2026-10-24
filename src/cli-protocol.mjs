/**
 * Direct implementation of the official Perch CLI turn protocol.
 *
 * Reversed from perchai-cli@2.4.115 (dist/perch.mjs) and confirmed against
 * captured live traffic:
 *   1. POST /api/perch-terminal/cli-context  -> {session:{userId,workspaceId}}
 *   2. POST /api/perch-terminal/turn-ticket  -> signed ticket + runId (surface "cli")
 *   3. POST /api/perch-terminal/model-call   -> SSE, requires x-perch-turn-ticket
 *
 * The ticket is signed server-side and bound to surface=cli, so it must be
 * acquired per turn and never forged or reused across surfaces.
 */

const CLI_USER_AGENT = "perchai-cli/2.4.115";
const CLI_SURFACE = "cli";
const CLI_PROFILE = "standard";
const LOCALE = "en";
const TICKET_RENEW_MARGIN_MS = 30_000;

export class CliProtocolError extends Error {
  constructor(message, { status = 0, code = null, detail = null } = {}) {
    super(message);
    this.name = "CliProtocolError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function baseHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    "x-perch-locale": LOCALE,
    "user-agent": CLI_USER_AGENT,
  };
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

export class CliProtocol {
  /**
   * @param {{origin:string, session:{access_token:string,user?:{id:string}}, fetchImpl?:Function}} opts
   */
  constructor({ origin, session, fetchImpl = fetch }) {
    if (!origin) throw new CliProtocolError("Missing Perch origin", { code: "origin_missing" });
    if (!session?.access_token) throw new CliProtocolError("Missing Perch access token", { status: 401, code: "not_authenticated" });
    this.origin = String(origin).replace(/\/+$/, "");
    this.session = session;
    this.fetchImpl = fetchImpl;
    this._context = null;
    this._ticket = null;
  }

  async _post(pathname, body, extraHeaders = {}, signal) {
    let res;
    try {
      res = await this.fetchImpl(this.origin + pathname, {
        method: "POST",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...baseHeaders(this.session.access_token),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new CliProtocolError("Could not reach Perch: " + error.message, {
        code: "cli_network_error",
      });
    }
    return res;
  }

  /** Account-scoped workspace identity, cached for the lifetime of the client. */
  async context({ signal } = {}) {
    if (this._context) return this._context;
    const res = await this._post("/api/perch-terminal/cli-context", { query: "", includeIndex: false }, {}, signal);
    const data = await readJson(res);
    if (!res.ok || data.ok !== true || !data.session?.userId || !data.session?.workspaceId) {
      throw new CliProtocolError(data.error || "Perch CLI context is unavailable (" + res.status + ")", {
        status: res.status,
        code: data.errorCode || data.error || "cli_context_unavailable",
        detail: data,
      });
    }
    this._context = {
      userId: data.session.userId,
      workspaceId: data.session.workspaceId,
      orgId: data.session.orgId || null,
      planCode: data.session.planCode || null,
    };
    return this._context;
  }

  /** Acquire a signed turn ticket (one per turn). */
  async takeTicket({ signal } = {}) {
    if (this._ticket && this._ticket.expiresAt - Date.now() > TICKET_RENEW_MARGIN_MS) {
      return this._ticket;
    }
    const res = await this._post(
      "/api/perch-terminal/turn-ticket",
      { surface: CLI_SURFACE, profile: CLI_PROFILE },
      { "user-agent": CLI_USER_AGENT },
      signal,
    );
    const data = await readJson(res);
    if (!res.ok || data.ok !== true) {
      const code = res.status === 429 ? (data.errorCode || "turn_rate_limited")
        : (data.errorCode || "turn_ticket_unavailable");
      throw new CliProtocolError(data.error || "Perch could not start a CLI turn (" + res.status + ")", {
        status: res.status,
        code,
        detail: data,
      });
    }
    if (!data.ticket || !data.runId) {
      throw new CliProtocolError("Perch returned an incomplete turn ticket", { code: "turn_ticket_invalid", detail: data });
    }
    const expiry = data.expiresAt ? Date.parse(data.expiresAt) : Date.now() + 300_000;
    this._ticket = {
      ticket: data.ticket,
      ticketId: data.ticketId || null,
      runId: data.runId,
      expiresAt: Number.isFinite(expiry) ? expiry : Date.now() + 300_000,
      profile: data.profile || CLI_PROFILE,
      enforced: data.enforced === true,
    };
    return this._ticket;
  }

  /**
   * Run one streaming model call. Yields the upstream CLI SSE events
   * (answer_delta, reasoning_delta, status/retrying, done, ...).
   */
  async *stream({
    optionId,
    messages,
    tools = [],
    temperature = 0.6,
    maxTokens = 32000,
    toolChoice = "none",
    lane = "chat",
    signal,
  }) {
    if (!optionId) throw new CliProtocolError("Missing CLI model option id", { status: 400, code: "cli_model_unavailable" });
    const [ctx, ticket] = await Promise.all([this.context({ signal }), this.takeTicket({ signal })]);
    this.lastRunId = ticket.runId;
    const body = {
      request: { messages, tools, temperature, maxTokens, toolChoice },
      runId: ticket.runId,
      lane,
      // Keep the requested model pinned instead of silently falling back.
      strictManual: true,
      preferredModelId: optionId,
      avoidModelIds: [],
      attribution: {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        runId: ticket.runId,
        lane,
        source: "tool_loop",
        billingMultiplier: null,
      },
      clientSurface: CLI_SURFACE,
      resendAfterOutput: true,
      manualModelOptionId: optionId,
    };

    const res = await this._post(
      "/api/perch-terminal/model-call",
      body,
      { Accept: "text/event-stream", "x-perch-turn-ticket": ticket.ticket },
      signal,
    );
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      let data = {};
      try { data = JSON.parse(raw); } catch {}
      throw new CliProtocolError(
        data.error || "Perch model call failed (" + res.status + ")" + (raw && !data.error ? ": " + raw.slice(0, 200) : ""),
        { status: res.status, code: data.errorCode || (res.status === 429 ? "usage_limit_reached" : "api_error"), detail: data },
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, cut).replace(/\r$/, "");
          buffer = buffer.slice(cut + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          yield event;
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith("data:")) {
        try { yield JSON.parse(tail.slice(5).trim()); } catch {}
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
