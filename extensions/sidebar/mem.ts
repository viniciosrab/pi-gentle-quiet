// The MEM tab of gentle-quiet's side column; the contract is in ./tabs.ts. Still to come: a placeholder card.
import type { SidebarHost, SidebarTab } from "./tabs.ts";

export function createTab(host: SidebarHost): SidebarTab {
	return { id: "mem", render: (width) => host.card("MEM — coming soon", [], width) };
}
