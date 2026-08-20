// Host half of the peak-valley-alarm plugin.
// The reminder work happens in the client half (lib/client.js), which
// registers a `shell.overlay` list-slot entry rendering transition toasts,
// browser notifications / chimes with the current input/output token prices.
// The DeepSeek API balance proxy lives in peak-valley-ticker
// (/peak-valley-ticker/balance), which owns the always-visible balance row.
// This host half exists so the plugin row composes as a normal Cordis entry;
// the client bundle is declared via package.json `dsh.client`.

export const name = 'peak-valley-alarm'

export const inject = []

export function apply() {
  // No host-side contribution: everything happens in the browser surface.
}
