#!/usr/bin/env node
// Publish this game to the Playtest Vault: run by .github/workflows/vault-publish.yml on every merge into main.
// The master copy lives in the vault's repo (DD1000/playtest-vault, integrations/github/vault-publish.mjs); each game
// has the same file in tools/. No packages, just Node 20+.
//
// 1. Skips a commit with "[skip publish]", or whose pull request title (or commit message) starts with "WIP:".
// 2. Asks the vault for the next version (its newest web build's last number + 1).
// 3. Runs VAULT_STAMP with {version} filled in (puts the version into the game), then VAULT_BUILD.
// 4. Uploads every file in VAULT_DIST straight to the vault's storage, and publishes it: the pull request's title is the
//    patch note, "Resolves: <note ids>" in it marks those tester notes done, and every tester who can play it is alerted.
// 5. The game's splash art (splash.png, .jpg or .webp at the top of the repo, or VAULT_SPLASH) becomes its cover in the
//    vault: the art on its page, its cards and Heartwave's launch screen. Sent only when it changed (16:9 looks best,
//    e.g. 1920×1080; the vault shrinks it). No splash art: the vault keeps the cover it has.
//
// Signing in to the vault, either:
// - GitHub's own sign-in (Oct 13; no secret at all): the job has `permissions: id-token: write`, and the studio lead
//   connected this repo to its game (`vault.mts publish-repo <game> <owner/repo>`). The vault checks with GitHub that
//   the run is this repo's .github/workflows/vault-publish.yml on main. Works for repos anyone owns.
// - Or VAULT_PUBLISH_TOKEN, the game's publish token (a secret in the repo's "vault" environment, main only).
// Either way it can only add web builds of this one game.
//
// Environment: VAULT_DIST, VAULT_STAMP, VAULT_BUILD, optional VAULT_SPLASH, VAULT_URL, VAULT_CHECK=1 (only check this repo is
// connected, publish nothing); GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA from Actions.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const env = process.env;
const VAULT = (env.VAULT_URL || "https://playtest-vault.vercel.app").replace(/\/+$/, "");
const TOKEN = env.VAULT_PUBLISH_TOKEN || "";
const DIST = env.VAULT_DIST || "";
const repo = env.GITHUB_REPOSITORY || "";
const sha = env.GITHUB_SHA || "";
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\.git\/)/;
const TYPES = { html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", wasm: "application/wasm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", txt: "text/plain", webmanifest: "application/manifest+json", pck: "application/octet-stream" };

const log = (line) => console.log(line);
const summary = (line) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
const stop = (why) => {
  log(why);
  summary(why);
  process.exit(0);
};
const die = (why) => {
  console.error(`✖ ${why}`);
  summary(`✖ ${why}`);
  process.exit(1);
};

// GitHub's sign-in token for this run, fresh for each call (they last a few minutes).
const OIDC_URL = env.ACTIONS_ID_TOKEN_REQUEST_URL || "";
const bearer = async () => {
  if (TOKEN) return TOKEN;
  const url = new URL(OIDC_URL);
  url.searchParams.set("audience", "playtest-vault");
  const res = await fetch(url, { headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } }).catch(() => null);
  const json = res?.ok ? await res.json().catch(() => null) : null;
  if (!json?.value) die(`GitHub didn't give this run a sign-in token (${res?.status ?? "no answer"}).`);
  return json.value;
};
if (!TOKEN && !(OIDC_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN))
  die("The vault can't tell who this is: give the job `permissions: id-token: write` (GitHub's sign-in), or the game's VAULT_PUBLISH_TOKEN.");

// soft: a problem is returned as { error } instead of stopping the run.
const call = async (body, { soft = false } = {}) => {
  const res = await fetch(`${VAULT}/api/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${await bearer()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((e) => ({ ok: false, status: String(e), json: async () => ({}) }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = json.error || `The vault answered ${res.status}.`;
    if (soft) return { error: why };
    die(why);
  }
  return json;
};

// The splash art that becomes the game's cover in the vault, if the repo has one.
const SPLASH_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const splashArt = () => {
  const path = env.VAULT_SPLASH || Object.keys(SPLASH_TYPES).map((ext) => `splash.${ext}`).find((p) => existsSync(p));
  if (!path) return null;
  if (!existsSync(path)) return log(`! VAULT_SPLASH is ${path}, but there's no such file: the cover stays as it is.`), null;
  const type = SPLASH_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
  if (!type) return log(`! ${path}: splash art must be a .png, .jpg or .webp: the cover stays as it is.`), null;
  return { path, type };
};

if (env.VAULT_CHECK) {
  const who = await call({ step: "check" });
  const art = splashArt();
  log(art ? `✔ Splash art: ${art.path} becomes the cover when it changes.` : "No splash art (splash.png, .jpg or .webp at the top of the repo): the vault keeps the cover it has.");
  stop(`✔ Connected: this repo publishes ${who.title} (${who.game}) to the Playtest Vault, ${who.via === "github" ? "with GitHub's sign-in (no secret)" : "with its publish token"}. Nothing was published.`);
}
if (!DIST) stop("Nothing to publish yet: this game has no web build (VAULT_DIST isn't set).");
// A folder that's made by hand (no build step) and isn't there yet: nothing to publish, and no version used up.
if (!env.VAULT_BUILD && !existsSync(join(DIST, "index.html"))) stop(`Nothing to publish yet: there's no ${DIST}/index.html.`);

// What's being published: the merged pull request, or the commit itself when the lead pushed straight to main.
const commit = execSync("git log -1 --format=%B", { encoding: "utf8" }).trim();
let title = commit.split("\n")[0];
let text = commit;
let who = "";
if (env.GITHUB_TOKEN && repo && sha) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/pulls`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
  }).catch(() => null);
  const pulls = res?.ok ? await res.json() : [];
  const pr = Array.isArray(pulls) ? pulls.find((p) => p.merged_at) ?? pulls[0] : null;
  if (pr) {
    title = pr.title;
    text = `${pr.title}\n${pr.body ?? ""}\n${commit}`;
    who = pr.user?.login ? ` (by @${pr.user.login}, #${pr.number})` : "";
  }
}
if (/\[skip publish\]/i.test(text)) stop("Skipped: [skip publish].");
if (/^\s*WIP:/i.test(title)) stop(`Skipped: “${title}” is marked WIP (Alexander's rule: unfinished work isn't published).`);
const resolves = [...new Set([...text.matchAll(/resolves?:?\s*((?:[0-9a-f]{8}[0-9a-f-]*[\s,]*)+)/gi)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean)))];

const { buildId, version, game } = await call({ step: "start" });
log(`▶ ${game} ${version}: ${title}`);
const run = (label, command) => {
  if (!command) return;
  log(`$ ${label}`);
  execSync(command.replaceAll("{version}", version), { stdio: "inherit", shell: "/bin/bash" });
};
run("stamp the version", env.VAULT_STAMP);
run("build", env.VAULT_BUILD);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const files = walk(DIST).map((full) => relative(DIST, full).split(sep).join("/")).filter((p) => !JUNK.test(p));
if (!files.length) die(`${DIST} is empty after the build.`);
const { uploads } = await call({ step: "uploads", buildId, paths: files });
let bytes = 0;
for (const { path, url } of uploads) {
  const data = readFileSync(join(DIST, path));
  bytes += data.length;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "PUT", headers: { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "max-age=3600" }, body: data }).catch((e) => ({ ok: false, status: String(e) }));
    if (res.ok) break;
    if (attempt === 3) die(`Couldn't upload ${path} (${res.status}).`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}
log(`  uploaded ${files.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB`);

// The splash art, only when it isn't the art the cover already came from. Never stops the publish.
let splash;
const art = splashArt();
if (art) {
  const data = readFileSync(art.path);
  const hash = createHash("sha256").update(data).digest("hex");
  const answer = await call({ step: "splash", buildId, hash }, { soft: true });
  if (answer.error) log(`! Splash art not sent: ${answer.error}`);
  else if (answer.same) log(`  splash art unchanged (${art.path})`);
  else if (answer.maxBytes && data.length > answer.maxBytes) log(`! ${art.path} is over ${Math.round(answer.maxBytes / 1024 / 1024)} MB: the cover stays as it is.`);
  else {
    const res = await fetch(answer.url, { method: "PUT", headers: { "content-type": art.type }, body: data }).catch((e) => ({ ok: false, status: String(e) }));
    if (res.ok) splash = hash;
    else log(`! Couldn't upload the splash art (${res.status}): the cover stays as it is.`);
  }
}

const done = await call({ step: "finish", buildId, notes: `${title}${who}`, source: repo && sha ? `${repo}@${sha}` : undefined, resolves, splash });
const cover = done.cover === "updated" ? " · new cover art from the splash art" : done.cover === "error" ? ` · cover not changed: ${done.coverError}` : "";
const line = `✔ Published ${game} ${done.version} to the Playtest Vault: ${done.url}${done.resolved ? ` · ${done.resolved} tester note(s) marked done` : ""} · ${done.alerted} device(s) alerted${cover}`;
log(line);
summary(line);
