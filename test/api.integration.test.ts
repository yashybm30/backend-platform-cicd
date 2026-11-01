import "reflect-metadata";
import { beforeAll, afterAll, test, expect } from "vitest";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
const require = createRequire(import.meta.url);
const { AppModule } = require("../dist/app");
const { configure } = require("../dist/platform");
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  owner = randomUUID();
function token(sub = owner, tenantId = tenant, role = "admin") {
  return jwt.sign({ sub, tenantId, role }, process.env.JWT_SECRET!, {
    issuer: "portfolio-auth",
    audience: "portfolio-api",
    expiresIn: 300,
  });
}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let api: ReturnType<typeof request>;
beforeAll(async () => {
  process.env.JWT_SECRET = "integration-only-signing-key-".repeat(3);
  process.env.PLATFORM_ADMIN_SUB = owner;
  await require("../dist/database").migrate();
  app = await NestFactory.create(AppModule, { logger: false });
  configure(app);
  await app.listen(0, "127.0.0.1");
  api = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});
test("signed uploads persist metadata and complete once without cross-user access", async () => {
  const auth = { Authorization: `Bearer ${token()}` };
  const created = await api
    .post("/v1/media/uploads")
    .set(auth)
    .send({ contentType: "image/png", bytes: 4 })
    .expect(201);
  const uploaded = await fetch(created.body.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "Content-Length": "4" },
    body: Buffer.from([1, 2, 3, 4]),
  });
  expect(uploaded.status, await uploaded.text()).toBe(200);
  await api
    .post(`/v1/media/${created.body.id}/complete`)
    .set("Authorization", `Bearer ${token(randomUUID(), otherTenant)}`)
    .expect(404);
  await api.post(`/v1/media/${created.body.id}/complete`).set(auth).expect(201);
  await api.post(`/v1/media/${created.body.id}/complete`).set(auth).expect(201);
  expect((await api.get("/v1/media").set(auth)).body).toHaveLength(1);
  expect((await api.get("/v1/notifications").set(auth)).body).toHaveLength(1);
  await api
    .post("/v1/media/uploads")
    .set(auth)
    .send({ contentType: "text/html", bytes: 10 })
    .expect(400);
});
