/**
 * Minimal Telegram Bot API client. The base URL is configurable so tests can
 * point it at a local recording server; production uses https://api.telegram.org.
 * 429 responses surface `retryAfter` (seconds) so callers can reschedule.
 */
export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`${method}: ${code} ${description}`);
  }
  get isBlocked() {
    return this.code === 403;
  }
  get isRetryable() {
    return this.code === 429 || this.code >= 500 || this.code === 0;
  }
}

export type TgMessage = { message_id: number; chat: { id: number; type: string; title?: string }; poll?: { id: string } };

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
    private readonly timeoutMs = 15_000,
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TelegramError(method, 0, e instanceof Error ? e.message : "network error");
    }
    let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(method, res.status || 0, "invalid response");
    }
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? "error", body.parameters?.retry_after);
    return body.result as T;
  }

  /** Call with a bounded wait on 429 (for interactive replies). */
  async callWithRetry<T = unknown>(method: string, params: Record<string, unknown> = {}, maxWaitSec = 5): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call<T>(method, params);
      } catch (e) {
        if (e instanceof TelegramError && e.code === 429 && (e.retryAfter ?? 99) <= maxWaitSec && attempt < 2) {
          await new Promise((r) => setTimeout(r, (e.retryAfter ?? 1) * 1000));
          continue;
        }
        if (e instanceof TelegramError && e.code === 0 && attempt < 1) continue;
        throw e;
      }
    }
  }

  async sendDocument(chatId: number | string, file: { name: string; data: Buffer; mime: string }, extra: Record<string, unknown> = {}) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    form.set("document", new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
    const res = await fetch(`${this.baseUrl}/bot${this.token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const body = (await res.json()) as { ok: boolean; result?: TgMessage; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!body.ok) throw new TelegramError("sendDocument", body.error_code ?? res.status, body.description ?? "error", body.parameters?.retry_after);
    return body.result!;
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<{ data: Buffer; filePath: string }> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!f.file_path) throw new TelegramError("getFile", 400, "file_path missing");
    if (f.file_size && f.file_size > maxBytes) throw new TelegramError("getFile", 413, "file too big");
    const res = await fetch(`${this.baseUrl}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new TelegramError("downloadFile", res.status, "download failed");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new TelegramError("downloadFile", 413, "file too big");
      chunks.push(Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), filePath: f.file_path };
  }
}
