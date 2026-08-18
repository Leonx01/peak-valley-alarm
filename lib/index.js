// Host half of the peak-valley-alarm plugin.
// The reminder work happens in the client half (lib/client.js), which
// registers a `shell.overlay` list-slot entry rendering transition toasts and
// firing browser notifications / chimes when the 峰/谷 period flips.
// This host half exists so the plugin row composes as a normal Cordis entry;
// the client bundle is declared via package.json `dsh.client`.

export const name = 'peak-valley-alarm'

export const inject = []

export function apply() {
  // No host-side contribution: everything happens in the browser surface.
}
