// Dummy client — proves the full loop without any terminal/UI.
//
// It connects to the bridge socket, streams a chunk of fake terminal output
// (so Claude has context), sends a chat question, and prints the streamed
// reply. This is M1's end-to-end test.
//
// Usage:
//   node client/dummy.js "why did my build fail?"
//   node client/dummy.js            # uses a default question

import net from "node:net";
import os from "node:os";
import path from "node:path";

import { encode, createDecoder } from "../bridge/protocol.js";

const SOCK = process.env.TERM_COPILOT_SOCK || path.join(os.homedir(), ".term-copilot.sock");
const question = process.argv[2] || "What went wrong here and how do I fix it?";

// Fake terminal output to give Claude something concrete to react to.
const FAKE_TERMINAL = `$ npm run build
> frame-ui@0.1.0 build
> tsc -p tsconfig.json

src/server/clients/documents.ts:89:42 - error TS2345: Argument of type
'string | undefined' is not assignable to parameter of type 'string'.

89   const data = await getRawSignedUrl(docId);
                                        ~~~~~
Found 1 error in src/server/clients/documents.ts:89

$ `;

const sock = net.createConnection(SOCK, () => {
  // Optionally report a terminal cwd (so CLAUDE.md resolves from there).
  if (process.env.TC_CWD) {
    sock.write(encode({ type: "cwd", dir: process.env.TC_CWD }));
  }
  // Stream the fake terminal output first...
  sock.write(encode({ type: "term_data", data: FAKE_TERMINAL }));
  // ...then ask the question.
  sock.write(encode({ type: "chat_msg", text: question }));
  process.stdout.write(`\n\x1b[36m> ${question}\x1b[0m\n\n`);
});

const decode = createDecoder((msg) => {
  if (msg.type === "chat_stream") {
    process.stdout.write(msg.text);
  } else if (msg.type === "chat_done") {
    process.stdout.write("\n\n");
    sock.end();
    process.exit(0);
  } else if (msg.type === "chat_error") {
    console.error(`\n[error] ${msg.error}\n`);
    sock.end();
    process.exit(1);
  } else if (msg.type === "status") {
    // connection confirmation; ignore
  }
});

sock.on("data", decode);
sock.on("error", (e) => {
  console.error(`[client] socket error: ${e.message}`);
  console.error(`Is the bridge running?  (npm run bridge)`);
  process.exit(1);
});
