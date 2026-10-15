// Default account emails. Every interpolated value is HTML-escaped.

export interface AuthEmail {
  subject: string;
  html: string;
  text: string;
}

/** Override any of these with `auth({ emails })` to brand or translate them. */
export interface AuthEmails {
  verifyEmail(input: { link: string; appUrl: string }): AuthEmail;
  resetPassword(input: { link: string; appUrl: string }): AuthEmail;
  /** Sent when someone registers with an email that already has an account. */
  alreadyRegistered(input: { forgotPasswordLink: string; appUrl: string }): AuthEmail;
}

/** Structural mailer: `ctx.mail` from @miujs/mail, `createMailer()`, or your own. */
export interface AuthMailer {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<unknown>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function button(link: string, label: string): string {
  return `<p><a href="${esc(link)}">${esc(label)}</a></p>`;
}

export const defaultAuthEmails: AuthEmails = {
  verifyEmail: ({ link }) => ({
    subject: "Confirm your email address",
    html: `<p>Confirm your email address by opening this link:</p>${button(link, "Confirm email")}<p>The link expires in 24 hours. If you did not sign up, ignore this email.</p>`,
    text: `Confirm your email address by opening this link:\n\n${link}\n\nThe link expires in 24 hours. If you did not sign up, ignore this email.`,
  }),
  resetPassword: ({ link }) => ({
    subject: "Reset your password",
    html: `<p>Someone asked to reset the password for this account. To choose a new password, open this link:</p>${button(link, "Reset password")}<p>The link expires in 1 hour and works once. If you did not ask for this, ignore this email; your password stays the same.</p>`,
    text: `Someone asked to reset the password for this account. To choose a new password, open this link:\n\n${link}\n\nThe link expires in 1 hour and works once. If you did not ask for this, ignore this email; your password stays the same.`,
  }),
  alreadyRegistered: ({ forgotPasswordLink }) => ({
    subject: "Someone tried to sign up with your email",
    html: `<p>Someone tried to create an account with this email address, but you already have one. Sign in with your password, or reset it here:</p>${button(forgotPasswordLink, "Reset password")}<p>If this wasn't you, ignore this email; nothing changed.</p>`,
    text: `Someone tried to create an account with this email address, but you already have one. Sign in with your password, or reset it here:\n\n${forgotPasswordLink}\n\nIf this wasn't you, ignore this email; nothing changed.`,
  }),
};
