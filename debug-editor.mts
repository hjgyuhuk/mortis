import { AgentTui } from '/Volumes/KIOXIA/Code/PersonalProjects/mortis/src/tui/index.js'
const tui = new AgentTui('m', 'http://x/v1', { interactive: true })
const lines = (tui as unknown as { ui: { render(w: number): string[] } }).ui.render(60)
for (const [i, l] of lines.entries()) console.log(i, JSON.stringify(l))
