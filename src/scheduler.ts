import { MINUTE_MS } from "./config";
import { runPipeline } from "./pipeline";
import { getSettings } from "./settings";

async function tick(): Promise<void> {
    if (!getSettings().schedulerEnabled) return;
    try {
        await runPipeline();
    } catch (error) {
        console.error("[scheduler]", error);
    }
}

export function startScheduler(): void {
    setTimeout(tick, 2_000);
    setInterval(tick, MINUTE_MS);
}