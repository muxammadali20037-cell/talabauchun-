import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Call = { method: string; params: Record<string, unknown> };

/**
 * Local stand-in for the Telegram Bot API (tests only). It records every call
 * the real client makes and returns response shapes from the Bot API docs, so
 * bot logic, rate-limit/429 handling and file download are exercised end to
 * end without network access. Never used outside tests.
 */
export class FakeTelegram {
  calls: Call[] = [];
  files = new Map<string, Buffer>();
  private failures: { method: string; error: { error_code: number; description: string; parameters?: { retry_after?: number } } }[] = [];
  private server: Server | null = null;
  private seq = 1000;
  url = "";

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const fileMatch = /^\/file\/bot[^/]+\/documents\/(.+)$/.exec(req.url ?? "");
        if (fileMatch) {
          const data = this.files.get(decodeURIComponent(fileMatch[1]!));
          if (!data) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
          return;
        }
        const m = /^\/bot[^/]+\/(\w+)$/.exec(req.url ?? "");
        if (!m) {
          res.writeHead(404).end();
          return;
        }
        const method = m[1]!;
        let params: Record<string, unknown> = {};
        const body = Buffer.concat(chunks);
        if ((req.headers["content-type"] ?? "").includes("application/json") && body.length) params = JSON.parse(body.toString("utf8"));
        else if ((req.headers["content-type"] ?? "").includes("multipart/form-data")) params = { multipart: true, size: body.length };
        this.calls.push({ method, params });
        const failIdx = this.failures.findIndex((f) => f.method === method);
        if (failIdx >= 0) {
          const f = this.failures.splice(failIdx, 1)[0]!;
          res.writeHead(f.error.error_code, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, ...f.error }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: this.result(method, params) }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  failNext(method: string, error_code: number, description: string, retry_after?: number) {
    this.failures.push({ method, error: { error_code, description, ...(retry_after ? { parameters: { retry_after } } : {}) } });
  }

  byMethod(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  last(method: string) {
    const list = this.byMethod(method);
    return list[list.length - 1];
  }

  reset() {
    this.calls = [];
  }

  private result(method: string, p: Record<string, unknown>): unknown {
    const chat = { id: Number(p.chat_id ?? 0), type: Number(p.chat_id ?? 0) < 0 ? "supergroup" : "private" };
    switch (method) {
      case "sendMessage":
      case "editMessageText":
      case "sendInvoice":
      case "sendDocument":
        return { message_id: this.seq++, chat, date: Math.floor(Date.now() / 1000), text: p.text };
      case "sendPoll": {
        const id = `poll_${this.seq++}`;
        return {
          message_id: this.seq++, chat, date: Math.floor(Date.now() / 1000),
          poll: { id, question: p.question, options: (p.options as { text: string }[]).map((o) => ({ text: o.text, voter_count: 0 })), total_voter_count: 0, is_closed: false, is_anonymous: p.is_anonymous, type: "quiz", allows_multiple_answers: false, allows_revoting: false, members_only: false, correct_option_ids: p.correct_option_ids },
        };
      }
      case "getFile": {
        const id = String(p.file_id);
        return { file_id: id, file_unique_id: id, file_size: this.files.get(id)?.length ?? 0, file_path: `documents/${id}` };
      }
      case "getChatMember":
        return { status: "member", user: { id: Number(p.user_id), is_bot: true, first_name: "bot" } };
      case "createInvoiceLink":
        return `https://t.me/$invoice_${this.seq++}`;
      case "getMe":
        return { id: 42, is_bot: true, first_name: "TALABA AI", username: "talaba_test_bot" };
      default:
        return true;
    }
  }
}
