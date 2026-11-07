import { join } from "node:path";
export const root = join(import.meta.dir, "..");
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
export async function waitDead(pid: number, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!alive(pid)) return true;
		await Bun.sleep(25);
	}
	return !alive(pid);
}
