import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app, db, redis, connect, disconnect } from "./helpers";
describe("Redis session authentication", () => {
  const email = `auth-${randomUUID()}@example.com`;
  const password = "LongPassword1234";
  const agent = request.agent(app);
  let cookie = "";
  beforeAll(connect);
  afterAll(async () => {
    await db.user.deleteMany({ where: { email } });
    await disconnect();
  });
  test("anonymous requests are refused", async () => {
    expect((await agent.get("/auth/me")).status).toBe(401);
  });
  test("rejects invalid email and weak password", async () => {
    expect(
      (await agent.post("/auth/register").send({ email: "bad", password: "short" })).status,
    ).toBe(400);
  });
  test("registers with a hash and hides it", async () => {
    const response = await agent.post("/auth/register").send({ email, password });
    expect(response.status).toBe(201);
    expect(response.body.email).toBe(email);
    expect(response.body.passwordHash).toBeUndefined();
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).not.toBe(password);
    expect(await Bun.password.verify(password, user.passwordHash)).toBe(true);
  });
  test("refuses duplicate registrations", async () => {
    expect((await agent.post("/auth/register").send({ email, password })).status).toBe(409);
  });
  test("refuses wrong passwords and unknown accounts", async () => {
    for (const input of [
      { email, password: "WrongPassword1234" },
      { email: "missing@example.com", password },
    ])
      expect((await agent.post("/auth/login").send(input)).status).toBe(401);
  });
  test("creates a session in Redis with an HTTP-only cookie", async () => {
    const response = await agent.post("/auth/login").send({ email, password });
    expect(response.status).toBe(200);
    const cookies = response.headers["set-cookie"];
    cookie = (Array.isArray(cookies) ? cookies[0] : cookies) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const current = await agent.get("/auth/me");
    expect(current.body.email).toBe(email);
    const keys = await redis.keys("dailybrief:session:*");
    expect(keys.length).toBeGreaterThan(0);
  });
  test("rejects cross-origin mutations", async () => {
    expect(
      (await agent.post("/auth/logout").set("Origin", "https://attacker.example")).status,
    ).toBe(403);
  });
  test("logout invalidates even a replayed cookie", async () => {
    expect((await agent.post("/auth/logout")).status).toBe(204);
    expect((await agent.get("/auth/me")).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});
