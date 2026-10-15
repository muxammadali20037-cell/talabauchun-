/**
 * Optional semantic embeddings. Anthropic does not offer an embeddings API, so
 * a separate provider is used when configured (Voyage AI, 1024-dim models).
 * Without it, retrieval uses Postgres full-text + trigram search only.
 */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

export class VoyageEmbedder implements Embedder {
  constructor(private readonly apiKey: string, readonly model = "voyage-3.5", private readonly baseUrl = "https://api.voyageai.com") {}

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, input_type: kind, output_dimension: 1024 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}`);
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
