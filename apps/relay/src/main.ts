import { createRelay } from "./index.js";

const app = await createRelay({ logger: true });
await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? "0.0.0.0" });
