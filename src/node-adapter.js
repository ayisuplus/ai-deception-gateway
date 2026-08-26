import { Buffer } from "node:buffer";

// Shared node:http ↔ web API converters used by the standalone gateway
// (src/app.js) and the connect-style middleware (src/middleware.js).

export const MAX_BODY_BYTES = 8192;

function readBody(nodeRequest, maximum = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    nodeRequest.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        nodeRequest.destroy();
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks)));
    nodeRequest.on("error", reject);
  });
}

// Convert a node:http IncomingMessage to a web Request. `withBody` buffers the
// request stream; callers must only opt in when they own the response (the
// standalone gateway, or the middleware's own admin routes) — buffering a body
// that downstream handlers still need would starve them.
export async function toWebRequest(nodeRequest, { withBody } = {}) {
  const url = `http://${nodeRequest.headers.host ?? "localhost"}${nodeRequest.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value != null) {
      headers.append(name, String(value));
    }
  }
  const body = withBody ? await readBody(nodeRequest) : undefined;
  return new Request(url, { method: nodeRequest.method, headers, body });
}

export async function writeWebResponse(nodeResponse, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  nodeResponse.writeHead(response.status, headers);
  const body = await response.arrayBuffer();
  nodeResponse.end(body.byteLength > 0 ? Buffer.from(body) : undefined);
}
