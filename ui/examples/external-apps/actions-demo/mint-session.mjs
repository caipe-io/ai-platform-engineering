#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Local development only. Creates a stored session the way ui/src/lib/auth-token-store.ts does,
// then prints the matching `next-auth.session-token` cookie value. With SSO off the host has no
// login page, so this is how a browser (or the UI check) gets a signed-in user.
//
//   NEXTAUTH_SECRET=... node mint-session.mjs [sub] [email]

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import { MongoClient } from "mongodb";
import { encode } from "next-auth/jwt";

const SESSION_FORMAT = 2;
const SESSION_SECONDS = 24 * 60 * 60;

export async function mintSession({
  sub = "primary-user",
  email = "primary@example.test",
  secret = process.env.NEXTAUTH_SECRET,
  uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
  database = process.env.MONGODB_DATABASE ?? "caipe",
} = {}) {
  if (!secret) throw new Error("NEXTAUTH_SECRET is required and must match ui/.env.local");
  const id = crypto.randomUUID();
  const tokens = { accessToken: "example-access-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, "", "caipe-auth-session-v2", 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([id, sub])));
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
  const enc = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");

  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client.db(database).collection("auth_sessions").insertOne({
      _id: id, sub, enc, version: 1, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
    });
  } finally {
    await client.close();
  }
  return encode({
    secret, maxAge: SESSION_SECONDS,
    token: {
      sub, name: "Primary Tester", email, sessionFormat: SESSION_FORMAT, sessionId: id,
      role: "admin", isAuthorized: true, canViewAdmin: true, canAccessDynamicAgents: true, org: "caipe",
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sub, email] = process.argv.slice(2);
  process.stdout.write(`${await mintSession({ ...(sub ? { sub } : {}), ...(email ? { email } : {}) })}\n`);
}
