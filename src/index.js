import { createGateway } from "./app.js";
import { ADMIN_PATH, LAB_HOME_PATH } from "./routes.js";

const gateway = createGateway();

gateway.server.on("error", (error) => {
  console.error(`Gateway failed: ${error.message}`);
  process.exitCode = 1;
});

const address = await gateway.start();
const host = address.address.includes(":") ? `[${address.address}]` : address.address;
console.log(`AI Deception Gateway running at http://${host}:${address.port}`);
console.log(`Event Horizon Lab: http://${host}:${address.port}${LAB_HOME_PATH}`);
console.log(`Dashboard: http://${host}:${address.port}${ADMIN_PATH}`);
console.log(`Mode: ${gateway.state.mode}`);

async function shutdown() {
  await gateway.stop();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
