import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Controller } from "../controller/controller.ts";
import type { Records } from "../store/records.ts";

export interface WorkbenchOptions {
  host?: string;
  port?: number;
  controller?: Controller;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function page(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MABS Workbench</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#111827;color:#e5e7eb}body{max-width:1100px;margin:2rem auto;padding:0 1rem}h1{margin-bottom:.25rem}.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}.card{background:#1f2937;border:1px solid #374151;border-radius:9px;padding:1rem;margin:1rem 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #374151}button{background:#2563eb;color:white;border:0;border-radius:5px;padding:.4rem .7rem;margin-right:.3rem}button.reject{background:#b91c1c}code{font-size:.85em}</style></head>
<body><h1>MABS Workbench</h1><div class="muted">Local controller state · refreshes every 3 seconds</div><div id="app"></div>
<script>
const token=${JSON.stringify(token)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function action(path){const r=await fetch(path,{method:'POST',headers:{'x-mabs-token':token}});if(!r.ok)alert(await r.text());await load()}
async function load(){const r=await fetch('/api/overview');const d=await r.json();
const counts=Object.entries(d.taskCounts).map(([k,v])=>'<div class="card"><b>'+esc(k)+'</b><div>'+v+'</div></div>').join('');
const tasks=d.tasks.map(t=>'<tr><td><code>'+esc(t.id)+'</code></td><td>'+esc(t.title)+'</td><td>'+esc(t.state)+'</td><td>'+esc(t.blockedReason||'')+'</td>'+(t.state==='RUNNING'?'<td><button class="reject" onclick="action(\'/api/tasks/'+encodeURIComponent(t.id)+'/cancel?version='+encodeURIComponent(t.recordVersion)+'\')">Cancel</button></td>':'<td></td>')+'</tr>').join('');
const approvals=d.approvals.map(a=>'<tr><td>'+esc(a.action)+'</td><td>'+esc(a.target)+'</td><td><code>'+esc(a.revision)+'</code></td><td><button onclick="action(\'/api/approvals/'+encodeURIComponent(a.id)+'/approve\')">Approve</button><button class="reject" onclick="action(\'/api/approvals/'+encodeURIComponent(a.id)+'/reject\')">Reject</button></td></tr>').join('');
document.querySelector('#app').innerHTML='<div class="grid">'+counts+'</div><div class="card"><h2>Tasks</h2><table><tr><th>ID</th><th>Task</th><th>State</th><th>Reason</th><th></th></tr>'+tasks+'</table></div><div class="card"><h2>Pending approvals</h2><table><tr><th>Action</th><th>Target</th><th>Revision</th><th></th></tr>'+approvals+'</table></div><div class="card"><h2>Controller health</h2><pre>'+esc(JSON.stringify(d.health,null,2))+'</pre></div>'}
load();setInterval(load,3000);
</script></body></html>`;
}

export function createWorkbench(records: Records, options: WorkbenchOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The v1 workbench may only bind to localhost");
  }
  const token = randomBytes(24).toString("base64url");
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const html = page(token);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const tasks = records.listTasks({ limit: 200 });
        const taskCounts: Record<string, number> = {};
        for (const task of tasks) taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
        json(response, 200, {
          projects: records.listProjects(),
          tasks,
          taskCounts,
          approvals: records.listApprovals("pending"),
          health: records.latestHealth() ?? null,
        });
        return;
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        const id = decodeURIComponent(taskMatch[1] as string);
        const task = records.getTask(id);
        if (!task) { json(response, 404, { error: "task not found" }); return; }
        json(response, 200, {
          task,
          attempts: records.listAttempts(id),
          gates: records.gatesForTask(id),
          events: records.listEvents(id),
        });
        return;
      }
      if (request.method === "POST") {
        if (request.headers["x-mabs-token"] !== token) { json(response, 403, { error: "invalid mutation token" }); return; }
        const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
        if (approvalMatch) {
          const approval = records.decideApproval(
            decodeURIComponent(approvalMatch[1] as string),
            approvalMatch[2] === "approve" ? "approved" : "rejected",
            "local-workbench",
          );
          json(response, 200, approval);
          return;
        }
        const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
        if (cancelMatch && options.controller) {
          const version = Number(url.searchParams.get("version"));
          if (!Number.isSafeInteger(version) || version < 1) { json(response, 400, { error: "record version is required" }); return; }
          await options.controller.cancelTask(decodeURIComponent(cancelMatch[1] as string), version);
          json(response, 200, { ok: true });
          return;
        }
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return {
    server,
    token,
    listen: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4317, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve({ host, port: typeof address === "object" && address ? address.port : (options.port ?? 4317) });
      });
    }),
  };
}
