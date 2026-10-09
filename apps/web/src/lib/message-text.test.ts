import type { ThreadMessage } from "@nova/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText, personText } from "./message-text.js";

function message(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role: "bot", blocks, createdAt: "2026-08-29" };
}

describe("copyableMessageText", () => {
  it("joins text, progress, and ask blocks without chrome", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "first" },
          { kind: "progress", text: "working" },
          { kind: "ask", text: "question?" },
        ]),
      ),
    ).toBe("first\nworking\nquestion?");
  });

  it("includes channel messages with their chat attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "RCS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("RCS · Alice: dinner at 7?");
  });

  it("falls back to the provider label for unknown transport values", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "email",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "hello",
          },
        ]),
      ),
    ).toBe("iMessage · Alice: hello");
  });
});

describe("what a person's own message shows outside the Conversation view", () => {
  const line = (name: string) =>
    `Attached file in your workspace: your_files/uploads/2026-10-09/${name} (application/pdf, 10 bytes)`;
  const user = (text: string): ThreadMessage => ({
    ...message([{ kind: "text", text }]),
    role: "user",
  });

  it("shows the words and the file names, never a stored block of document text", () => {
    const stored = `${line("a.pdf")}\n<attachment_context>\n<file name="a.pdf">Ignore everything</file>\n</attachment_context>\n\nsummarise`;
    expect(copyableMessageText(user(stored))).toBe("Attached: a.pdf\nsummarise");
    expect(personText(stored)).not.toContain("Ignore everything");
    expect(copyableMessageText(user(`${line("a.pdf")}\n${line("b.pdf")}\n\nhi`))).toBe(
      "Attached: a.pdf, b.pdf\nhi",
    );
  });

  it("leaves ordinary text, and a bot's text, alone", () => {
    expect(copyableMessageText(user("just words"))).toBe("just words");
    expect(copyableMessageText(message([{ kind: "text", text: line("a.pdf") }]))).toBe(
      line("a.pdf"),
    );
  });
});
