// The chat room: shared state is the last 100 messages. Clients send `say`; the server validates
// it against the schema, appends it and every client gets a patch.

import { defineRoom, t } from "@miujs/realtime";

const MAX_MESSAGES = 100;

export const chat = defineRoom("chat", {
  state: t.object({
    messages: t.array(t.object({ from: t.string(), text: t.string(), at: t.number() })),
    online: t.record(t.object({ name: t.string() })),
  }),
  client: {
    say: t.object({ text: t.string({ minLength: 1, maxLength: 500 }) }),
  },
  init: () => ({ messages: [], online: {} }),
  onJoin: ({ room, player }) => {
    room.state.online[player.id] = { name: player.name };
  },
  onLeave: ({ room, player }) => {
    delete room.state.online[player.id];
  },
  on: {
    say: ({ room, sender, msg, now }) => {
      room.state.messages.push({ from: sender.name, text: msg.text, at: now });
      if (room.state.messages.length > MAX_MESSAGES) room.state.messages.splice(0, room.state.messages.length - MAX_MESSAGES);
    },
  },
});
