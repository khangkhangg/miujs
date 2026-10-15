import { MiuError } from "miujs";

/** Every error @miujs/bots produces. Codes are stable; messages and fixes may improve. */
export const botsErrors = {
  config: (message: string, fix: string) => new MiuError({ code: "MIU_E_BOTS_CONFIG", status: 500, message, fix }),

  order: (before: string) =>
    new MiuError({
      code: "MIU_E_BOTS_ORDER",
      status: 500,
      message: `bots() runs before ${before}(), so it cannot tell signed-in users from anonymous visitors`,
      fix: `List ${before}() before bots() in miu({ plugins }): signed-in users then bypass the bot cache and partial responses.`,
    }),

  blocked: (status: number, who: string) =>
    new MiuError({
      code: "MIU_E_BOT_BLOCKED",
      status,
      message: `This site does not serve ${who}`,
      fix: "If you are a person, use a regular browser with cookies and JavaScript on. If you run a crawler, follow /robots.txt; site owners change access in bots({ policy, rules }).",
    }),
};
