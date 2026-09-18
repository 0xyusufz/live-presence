import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.get("/healthz", async () => ({
    status: "ok",
  }));

  return app;
}
