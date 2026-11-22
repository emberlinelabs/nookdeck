import { definePlugin } from "@nookdeck/plugin";

export default definePlugin({
  activate(ctx) {
    ctx.widgets.provide("hello", async () => ({ render: "stat", data: { value: "Hello", label: ctx.id } }), { every: 60 });
  },
});
