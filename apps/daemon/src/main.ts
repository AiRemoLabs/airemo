import { startDaemon } from "./server.js";

const port = process.env.AIREMO_PORT ? Number(process.env.AIREMO_PORT) : undefined;
const daemon = await startDaemon({ ...(port ? { port } : {}), logger: true });
const stop = () => daemon.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
