// Tiny markdown -> React renderer (CommonJS, no deps, no build step).
//
// Supports the subset Claude actually emits in chat: fenced code blocks,
// inline `code`, **bold**, *italic*, # headings, and - / * bullet lists.
// Everything else falls through as plain text. Good enough to make replies
// readable without pulling in a markdown library.

function makeRenderer(React, opts) {
  const h = React.createElement;
  const onInsertCode = (opts && opts.onInsertCode) || null;
  const onRunCode = (opts && opts.onRunCode) || null;

  // --- inline: `code`, **bold**, *italic* ---------------------------------
  function inline(text, keyPrefix) {
    const nodes = [];
    let i = 0;
    let k = 0;
    const push = (node) => nodes.push(node);
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) push(text.slice(last, m.index));
      const tok = m[0];
      const key = `${keyPrefix}-i${k++}`;
      if (tok.startsWith("`")) {
        push(h("code", { key, style: S.inlineCode }, tok.slice(1, -1)));
      } else if (tok.startsWith("**")) {
        push(h("strong", { key }, tok.slice(2, -2)));
      } else {
        push(h("em", { key }, tok.slice(1, -1)));
      }
      last = re.lastIndex;
    }
    if (last < text.length) push(text.slice(last));
    return nodes;
  }

  // GFM table helpers
  function splitCells(line) {
    let parts = line.split("|");
    if (parts.length && parts[0].trim() === "") parts.shift();
    if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
    return parts.map((s) => s.trim());
  }
  function isSeparator(line) {
    return /\|/.test(line) && /-/.test(line) && /^[\s:|-]+$/.test(line);
  }

  function renderTable(header, rows, key) {
    const head = h(
      "tr",
      { key: "h" },
      header.map((c, i) => h("th", { key: i, style: S.th }, inline(c, `th${i}`))),
    );
    const body = rows.map((r, ri) =>
      h(
        "tr",
        { key: ri },
        r.map((c, ci) => h("td", { key: ci, style: S.td }, inline(c, `td${ri}-${ci}`))),
      ),
    );
    return h("div", { key, style: S.tableWrap }, [
      h("table", { key: "t", style: S.table }, [
        h("thead", { key: "th" }, head),
        h("tbody", { key: "tb" }, body),
      ]),
    ]);
  }

  // --- block: split into paragraphs, code fences, headings, lists ---------
  function render(md) {
    const lines = (md || "").split("\n");
    const blocks = [];
    let i = 0;
    let k = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++; // closing fence
        const code = buf.join("\n");
        const children = [h("pre", { key: "pre", style: S.codeBlock }, code)];
        const btns = [];
        if (onInsertCode) {
          btns.push(
            h("button", {
              key: "ins",
              style: S.insertBtn,
              title: "Insert at the prompt (does not run — review, then press Enter)",
              onClick: () => onInsertCode(code),
            }, "→ insert"),
          );
        }
        if (onRunCode) {
          btns.push(
            h("button", {
              key: "run",
              style: S.runBtn,
              title: "Paste into the terminal AND run it",
              onClick: () => onRunCode(code),
            }, "▶ run"),
          );
        }
        if (btns.length) children.push(h("div", { key: "btns", style: S.codeBtns }, btns));
        blocks.push(h("div", { key: `b${k++}`, style: S.codeWrap }, children));
        continue;
      }

      // GFM table: a row of pipes followed by a |---|---| separator
      if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
        const header = splitCells(line);
        i += 2; // header + separator
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(splitCells(lines[i]));
          i++;
        }
        blocks.push(renderTable(header, rows, `b${k++}`));
        continue;
      }

      // heading
      const hm = /^(#{1,4})\s+(.*)$/.exec(line);
      if (hm) {
        blocks.push(
          h("div", { key: `b${k++}`, style: S.heading }, inline(hm[2], `b${k}`)),
        );
        i++;
        continue;
      }

      // bullet list (consecutive - / * lines)
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const content = lines[i].replace(/^\s*[-*]\s+/, "");
          items.push(h("li", { key: `li${i}`, style: S.li }, inline(content, `li${i}`)));
          i++;
        }
        blocks.push(h("ul", { key: `b${k++}`, style: S.ul }, items));
        continue;
      }

      // blank line -> spacer
      if (line.trim() === "") {
        i++;
        continue;
      }

      // paragraph: gather until blank/structural line
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^\s*```/.test(lines[i]) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      blocks.push(
        h("div", { key: `b${k++}`, style: S.para }, inline(para.join(" "), `b${k}`)),
      );
    }
    return blocks;
  }

  return render;
}

const S = {
  para: { margin: "6px 0", whiteSpace: "pre-wrap" },
  heading: { margin: "10px 0 4px", fontWeight: 600, color: "#aebfe0" },
  ul: { margin: "6px 0", paddingLeft: 18 },
  li: { margin: "2px 0" },
  inlineCode: {
    fontFamily: "Menlo, monospace",
    background: "#1c2230",
    borderRadius: 4,
    padding: "1px 4px",
    fontSize: "0.92em",
    color: "#e6b673",
  },
  tableWrap: { margin: "8px 0", overflowX: "auto", maxWidth: "100%" },
  table: { borderCollapse: "collapse", fontSize: 11.5, width: "100%" },
  th: {
    border: "1px solid #2a2f3a",
    padding: "3px 7px",
    textAlign: "left",
    background: "#161b24",
    color: "#aebfe0",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: {
    border: "1px solid #2a2f3a",
    padding: "3px 7px",
    color: "#c2c9d6",
    verticalAlign: "top",
  },
  codeWrap: { position: "relative", margin: "6px 0" },
  codeBlock: {
    fontFamily: "Menlo, monospace",
    background: "#0b0e14",
    border: "1px solid #2a2f3a",
    borderRadius: 6,
    padding: 8,
    margin: 0,
    overflowX: "auto",
    whiteSpace: "pre",
    fontSize: 12,
    color: "#cfe1c0",
  },
  codeBtns: { position: "absolute", top: 5, right: 5, display: "flex", gap: 5 },
  insertBtn: {
    background: "#1c2230",
    color: "#8ab4f8",
    border: "1px solid #2a2f3a",
    borderRadius: 5,
    fontSize: 10,
    padding: "2px 7px",
    cursor: "pointer",
    opacity: 0.9,
  },
  runBtn: {
    background: "#12261a",
    color: "#7ee0a1",
    border: "1px solid #2e6f4a",
    borderRadius: 5,
    fontSize: 10,
    padding: "2px 7px",
    cursor: "pointer",
    opacity: 0.95,
  },
};

module.exports = { makeRenderer };
