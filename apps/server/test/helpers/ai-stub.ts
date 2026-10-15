/**
 * Test double for the Anthropic SDK client (tests only). It returns scripted
 * `parsed_output` objects so the pipeline's handling of model output —
 * evidence verification, dropped fake quotes, blind-check disagreements — can
 * be tested deterministically without network access or an API key.
 */
export type StubCall = { system: string; user: string; model: string };
export function anthropicStub(responder: (call: StubCall) => unknown) {
  const calls: StubCall[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: { system: string; messages: { content: string }[]; model: string }) => {
          const call = { system: params.system, user: params.messages[0]!.content, model: params.model };
          calls.push(call);
          return { parsed_output: responder(call), stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500 }, model: params.model };
        },
      },
    },
  };
  return { client: client as never, calls };
}
