// Newline-delimited JSON (NDJSON) framing over a stream socket.
//
// Every message is a single JSON object on its own line. This keeps the wire
// format trivial to produce/consume from any language (the Hyper plugin, a
// shell client, a test script) without a length-prefix scheme.
//
// Message types
//   client -> bridge:
//     { "type": "term_data", "data": "<raw terminal output chunk>" }
//     { "type": "cwd",       "dir": "<terminal's current working directory>" }
//     { "type": "chat_msg",  "text": "<user message>" }
//   bridge -> client:
//     { "type": "chat_stream", "text": "<partial assistant text>" }
//     { "type": "chat_done" }
//     { "type": "chat_error",  "error": "<message>" }
//     { "type": "status",      "text": "<human-readable status>" }

export function encode(obj) {
  return JSON.stringify(obj) + "\n";
}

// Returns a function you feed raw socket chunks to; it calls `onMessage` for
// each complete JSON line and buffers partial lines across chunks.
export function createDecoder(onMessage) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        onMessage({ type: "_parse_error", error: String(err), raw: line });
      }
    }
  };
}
