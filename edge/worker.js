// Cloudflare Worker entry. The browser asset is imported as a Text module
// (see `rules` in edge/wrangler.toml); the handler factory itself is
// runtime-agnostic and unit-tested in Node via test/edge.test.js.
import assetScript from "../public/black-hole.v1.js";
import { createEdgeFetch } from "./worker.core.js";

let handler;

export default {
  fetch(request, env) {
    // One gateway per isolate; env bindings are stable for the isolate's life.
    handler ??= createEdgeFetch(assetScript, env);
    return handler(request);
  },
};
