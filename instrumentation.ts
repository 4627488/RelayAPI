export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeWebAccessKey } =
      await import("./src/server/services/webAccess");
    const { startCodexCredentialRefreshScheduler } =
      await import("./src/server/services/codexCredentialRefreshScheduler");
    const { resumePendingTimeZoneRebuild } =
      await import("./src/server/services/timeZoneRebuild");
    const { registerRequestLogWriterShutdown } =
      await import("./src/server/repositories/logs");
    initializeWebAccessKey();
    startCodexCredentialRefreshScheduler();
    resumePendingTimeZoneRebuild();
    registerRequestLogWriterShutdown();
  }
}
