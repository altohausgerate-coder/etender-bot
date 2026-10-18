// Sayt girişi: bir ümumi parol (KV-də PBKDF2 hash), HMAC imzalı sessiya cookie-si.

import { b64url, fromB64url } from "./push";

export interface AuthEnv {
  KV: KVNamespace;
  SESSION_SECRET: string;
}

const te = new TextEncoder();
const COOKIE = "et_s";
const SESSION_DAYS = 90;
const ITER = 20000;

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256));
}

export const hasPassword = async (env: AuthEnv) => !!(await env.KV.get("pwHash"));

export async function setPassword(env: AuthEnv, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await env.KV.put("pwHash", JSON.stringify({ salt: b64url(salt), hash: await pbkdf2(password, salt) }));
}

export async function checkPassword(env: AuthEnv, password: string): Promise<boolean> {
  const stored = await env.KV.get<{ salt: string; hash: string }>("pwHash", "json");
  if (!stored) return false;
  return (await pbkdf2(password, fromB64url(stored.salt))) === stored.hash;
}

async function sign(env: AuthEnv, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", te.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, te.encode(data)));
}

/** Parol dəyişəndə köhnə sessiyalar etibarsız olsun deyə imzaya "pwVer" daxil edilir. */
const pwVersion = async (env: AuthEnv) => (await env.KV.get("pwVer")) ?? "0";
export const bumpPwVersion = async (env: AuthEnv) => env.KV.put("pwVer", String(Date.now()));

export async function sessionCookie(env: AuthEnv): Promise<string> {
  const exp = String(Date.now() + SESSION_DAYS * 86400e3);
  const val = `${exp}.${await sign(env, `${exp}.${await pwVersion(env)}`)}`;
  return `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function isAuthed(env: AuthEnv, req: Request): Promise<boolean> {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === (await sign(env, `${exp}.${await pwVersion(env)}`));
}

// Sadə brute-force qoruması: saatda 10 uğursuz cəhd
export async function tooManyAttempts(env: AuthEnv, ip: string): Promise<boolean> {
  return Number((await env.KV.get(`fail:${ip}`)) ?? 0) >= 10;
}
export async function recordFail(env: AuthEnv, ip: string) {
  const n = Number((await env.KV.get(`fail:${ip}`)) ?? 0) + 1;
  await env.KV.put(`fail:${ip}`, String(n), { expirationTtl: 3600 });
}
