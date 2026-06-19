function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text: string): string {
  const REGEX = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|0x[0-9A-Fa-f]{4,})/g;
  return text
    .split(REGEX)
    .map((part) => {
      if (!part) return "";

      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        return `<a data-href="${escapeHtml(link[2])}" class="link">${escapeHtml(link[1])}</a>`;
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return `<strong>${renderInline(part.slice(2, -2))}</strong>`;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      if (part.startsWith("0x")) {
        return `<span class="hex">${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function cells(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .slice(1, -1);
}

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let inTable = false;
  let headers: string[] = [];
  let rows: string[][] = [];

  const closeList = () => {
    if (!listType) return;
    out.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = null;
  };

  const closeTable = () => {
    if (!inTable) return;
    const head = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
    const body = rows
      .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
      .join("");
    out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
    inTable = false;
    headers = [];
    rows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeTable();
      closeList();
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    if (isTableRow) {
      closeList();
      if (inTable) {
        if (!/^[\s|:-]+$/.test(trimmed)) rows.push(cells(line));
      } else {
        const next = lines[i + 1]?.trim() ?? "";
        if (next.startsWith("|") && /^[\s|:-]+$/.test(next)) {
          inTable = true;
          headers = cells(line);
          i++;
        } else {
          out.push(`<p>${renderInline(line)}</p>`);
        }
      }
      continue;
    } else {
      closeTable();
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    const ul = line.match(/^\s*[-*+]\s+(.*)/);

    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      listItems.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      listItems.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }
    closeList();

    if (line.startsWith("### ")) {
      out.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      continue;
    }
    if (trimmed === "") continue;

    out.push(`<p>${renderInline(line)}</p>`);
  }

  closeTable();
  closeList();
  if (inCode) out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);

  return out.join("");
}
