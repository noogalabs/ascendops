/**
 * Next.js boot hook. Runs once per server process, before any request is served.
 *
 * The dashboard is NOT an agent session. It inherits whatever environment started
 * it, and PM2 inherits the calling shell by design — so a dashboard launched from
 * an agent PTY carried that agent's session credential. Its task-completion route
 * propagates `process.env` into `completeTask()`, which refreshes the assignee's
 * heartbeat, so a wedged agent would look alive because a web request touched its
 * task.
 *
 * Deleting the marker from our own `process.env` here is the same by-construction
 * closure the daemon uses: every inheritance path shuts at once, however many
 * request handlers exist now or arrive later. Stripping at the pm2 invocations is
 * defence in depth for the launch we control; this covers the launches we do not.
 */
export async function register(): Promise<void> {
  delete process.env.CTX_HEARTBEAT_SESSION;
}
