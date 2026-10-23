// "Connected apps" on the Account card: Claude sessions authorised through OAuth, each with Disconnect.
import { api } from './api.js';
import { $, confirmDialog, esc, toast } from './ui.js';

const day = iso => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
let connections = [];

export async function renderConnections() {
  const el = $('[data-connections]');
  try {
    connections = (await api.connections()).connections;
  } catch {
    return; // secondary info: the rest of the page still works
  }
  el.innerHTML = connections.length
    ? connections.map(c => `
      <div class="conn-item">
        <div><b>${esc(c.name)}</b><br><small class="muted">Connected ${day(c.created_at)} · Last used ${day(c.last_used_at)}</small></div>
        <button class="ghost small" data-action="disconnect-app" data-id="${esc(c.id)}">Disconnect</button>
      </div>`).join('')
    : `<small class="muted">No apps connected. Add Hisaab to Claude with <code>${esc(location.origin)}/mcp</code></small>`;
}

export async function disconnectApp(id) {
  const c = connections.find(x => x.id === id);
  if (!c || !(await confirmDialog(`Disconnect ${c.name}?`, `${c.name} will no longer be able to read or change your Hisaab data.`, 'Disconnect'))) return;
  try {
    await api.disconnect(id);
    toast(`${c.name} disconnected`);
  } catch (err) {
    toast(err.message, 'danger');
  }
  renderConnections();
}
