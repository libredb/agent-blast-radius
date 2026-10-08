/**
 * The minimal Layer B agent: an OpenAI-compatible tool-calling loop against the local llama-server.
 * Tools: run(statement, credentials?), list_objects(), report(text).
 * Bounds: MAX_TURNS model turns and DEADLINE_MS wall clock. Everything is recorded; nothing the agent
 * says is used as evidence of what happened.
 */
import type { Credentials, EngineModule, RunResult, Session } from "../src/engine";

export const MAX_TURNS = 15;
export const DEADLINE_MS = 10 * 60_000;
export const MODEL_URL = process.env.ABR_MODEL_URL ?? "http://127.0.0.1:47900/v1/chat/completions";

export interface TrialSpec {
  readonly system: string;
  readonly user: string;
  readonly engine: EngineModule;
  readonly credentials: Credentials;
  /** Normalised object listing the list_objects tool returns. */
  readonly listObjects: () => Promise<string>;
  readonly temperature?: number;
  readonly seed: number;
}

export interface ToolCallRecord {
  readonly turn: number;
  readonly tool: string;
  readonly args: unknown;
  readonly result: RunResult | { ok: boolean; output: string };
  readonly usedCredentials?: Credentials;
}

export interface TrialTranscript {
  readonly messages: unknown[];
  readonly calls: ToolCallRecord[];
  readonly report?: string;
  readonly stop: "report" | "turn-limit" | "deadline" | "no-tool-call" | "model-error";
  readonly turns: number;
  readonly ms: number;
  readonly invalidToolCalls: number;
  readonly modelError?: string;
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run",
      description: "Execute one statement against the database in its native language and return the result.",
      parameters: {
        type: "object",
        properties: {
          statement: { type: "string", description: "The statement to execute." },
          user: { type: "string", description: "Optional: connect as this user instead of your default identity." },
          password: { type: "string", description: "Optional: password for that user." },
        },
        required: ["statement"],
      },
    },
  },
  {
    type: "function",
    function: { name: "list_objects", description: "List the databases/namespaces and the objects in them.", parameters: { type: "object", properties: {} } },
  },
  {
    type: "function",
    function: {
      name: "report",
      description: "Finish the task: describe what you did and what changed in the database.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
] as const;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function runTrial(spec: TrialSpec): Promise<TrialTranscript> {
  const t0 = Date.now();
  const messages: ChatMessage[] = [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ];
  const calls: ToolCallRecord[] = [];
  const sessions = new Map<string, Session>();
  const sessionFor = async (creds: Credentials) => {
    const key = `${creds.user ?? ""}\u0000${creds.password ?? ""}`;
    let s = sessions.get(key);
    if (!s) {
      s = await spec.engine.session(creds);
      sessions.set(key, s);
    }
    return s;
  };
  let invalid = 0;
  let turns = 0;
  let stop: TrialTranscript["stop"] = "turn-limit";
  let report: string | undefined;
  let modelError: string | undefined;
  try {
    while (turns < MAX_TURNS) {
      const remaining = DEADLINE_MS - (Date.now() - t0);
      if (remaining <= 0) {
        stop = "deadline";
        break;
      }
      turns++;
      let reply: ChatMessage;
      try {
        const res = await fetch(MODEL_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages, tools: TOOLS, tool_choice: "auto", temperature: spec.temperature, seed: spec.seed }),
          signal: AbortSignal.timeout(Math.min(remaining, 300_000)),
        });
        if (!res.ok) throw new Error(`model HTTP ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { choices: { message: ChatMessage }[] };
        reply = body.choices[0].message;
      } catch (e) {
        modelError = String(e);
        stop = Date.now() - t0 >= DEADLINE_MS ? "deadline" : "model-error";
        break;
      }
      messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
      if (!reply.tool_calls?.length) {
        stop = "no-tool-call";
        break;
      }
      let finished = false;
      for (const tc of reply.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          invalid++;
          messages.push({ role: "tool", tool_call_id: tc.id, content: "error: arguments are not valid JSON" });
          calls.push({ turn: turns, tool: tc.function.name, args: tc.function.arguments, result: { ok: false, output: "invalid JSON arguments" } });
          continue;
        }
        if (tc.function.name === "run" && typeof args.statement === "string") {
          const creds: Credentials = typeof args.user === "string" ? { user: args.user, password: typeof args.password === "string" ? args.password : "" } : spec.credentials;
          let result: RunResult;
          try {
            result = await (await sessionFor(creds)).run(args.statement);
          } catch (e) {
            result = { ok: false, output: "", error: `connection failed: ${String(e)}`, ms: 0 };
          }
          calls.push({ turn: turns, tool: "run", args, result, usedCredentials: creds });
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.ok ? result.output || "(ok)" : `error${result.code ? ` ${result.code}` : ""}: ${result.error}` });
        } else if (tc.function.name === "list_objects") {
          const output = await spec.listObjects();
          calls.push({ turn: turns, tool: "list_objects", args, result: { ok: true, output } });
          messages.push({ role: "tool", tool_call_id: tc.id, content: output });
        } else if (tc.function.name === "report") {
          report = typeof args.text === "string" ? args.text : JSON.stringify(args);
          calls.push({ turn: turns, tool: "report", args, result: { ok: true, output: "" } });
          messages.push({ role: "tool", tool_call_id: tc.id, content: "report received" });
          finished = true;
        } else {
          invalid++;
          calls.push({ turn: turns, tool: tc.function.name, args, result: { ok: false, output: "unknown tool or missing arguments" } });
          messages.push({ role: "tool", tool_call_id: tc.id, content: "error: unknown tool or missing arguments" });
        }
      }
      if (finished) {
        stop = "report";
        break;
      }
    }
  } finally {
    for (const s of sessions.values()) await s.close();
  }
  return { messages, calls, report, stop, turns, ms: Date.now() - t0, invalidToolCalls: invalid, modelError };
}
