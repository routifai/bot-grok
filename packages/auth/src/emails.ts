import type { TransactionalEmail } from "@nova/adapter-kit";

/** Minutes a one-time code stays valid; the same figure drives the auth plugin and the copy. */
export const OTP_EXPIRES_MINUTES = 5;
export const OTP_LENGTH = 6;

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

interface Layout {
  to: string;
  subject: string;
  /** One short line shown above the main element. */
  lead: string;
  /** The code or action; plain text carries it verbatim. */
  code?: string;
  action?: { label: string; url: string };
  footer: string;
}

/** One quiet, monochrome layout for every Nova email: plain text and HTML carry the same words. */
function render(layout: Layout): TransactionalEmail {
  const text = [
    "Nova",
    "",
    layout.lead,
    "",
    ...(layout.code ? [layout.code] : []),
    ...(layout.action ? [layout.action.url] : []),
    "",
    layout.footer,
  ].join("\n");
  const main = layout.code
    ? `<p style="margin:24px 0;font:600 32px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:8px;color:#111">${escapeHtml(layout.code)}</p>`
    : layout.action
      ? `<p style="margin:24px 0"><a href="${escapeHtml(layout.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#111;color:#fff;font:500 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none">${escapeHtml(layout.action.label)}</a></p>`
      : "";
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f5f5"><table role="presentation" width="100%" style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px"><tr><td style="padding:32px;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111"><p style="margin:0 0 24px;font-weight:600;font-size:17px;letter-spacing:-0.2px">Nova</p><p style="margin:0">${escapeHtml(layout.lead)}</p>${main}<p style="margin:0;color:#6b6b6b;font-size:13px">${escapeHtml(layout.footer)}</p></td></tr></table></body></html>`;
  return { to: layout.to, subject: layout.subject, text, html };
}

export type CodePurpose = "sign-in" | "email-verification" | "forget-password" | "change-email";

export function codeEmail(to: string, code: string, purpose: CodePurpose): TransactionalEmail {
  const lead =
    purpose === "email-verification"
      ? "Use this code to verify your email."
      : purpose === "sign-in"
        ? "Use this code to sign in."
        : "Use this code to continue.";
  return render({
    to,
    subject: `${code} is your Nova code`,
    lead,
    code,
    footer: `It expires in ${OTP_EXPIRES_MINUTES} minutes. If you did not ask for it, ignore this email.`,
  });
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  // No user-chosen text: the name is free-form input that would land in an email we send.
  return render({
    to: user.email,
    subject: "Reset your Nova password",
    lead: "Reset your Nova password here.",
    action: { label: "Reset password", url: resetUrl },
    footer: "This link expires in one hour. If you did not ask for it, ignore this email.",
  });
}
