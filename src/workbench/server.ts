import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Controller } from "../controller/controller.ts";
import { readArtifact, taskDiagnostics } from "../diagnostics/task.ts";
import { ACTIONS, type Action } from "../domain/policy.ts";
import type { Feedback, Records } from "../store/records.ts";

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

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64_000) throw new Error("Request body exceeds 64KB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

function page(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MABS Workbench</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#111827;color:#e5e7eb}body{max-width:1250px;margin:2rem auto;padding:0 1rem}h1{margin-bottom:.25rem}h2{margin-top:.2rem}.muted{color:#9ca3af}.warn{color:#fbbf24}.ok{color:#86efac}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1rem}.card{background:#1f2937;border:1px solid #374151;border-radius:9px;padding:1rem;margin:1rem 0;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:.55rem;border-bottom:1px solid #374151}button{background:#2563eb;color:white;border:0;border-radius:5px;padding:.4rem .7rem;margin:.15rem;cursor:pointer}button.reject{background:#b91c1c}button.secondary{background:#4b5563}code{font-size:.85em}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111827;padding:.8rem;border-radius:6px}a{color:#93c5fd;cursor:pointer}.pill{display:inline-block;padding:.15rem .45rem;border-radius:1rem;background:#374151;margin:.1rem}.toolbar{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:1rem 0}</style></head>
<body><h1>MABS Workbench</h1><div class="muted">Local plans, evidence, reviews, feedback, approvals, and troubleshooting</div><div class="toolbar"><button onclick="load()">Overview</button><span id="notice" class="muted"></span></div><div id="app"></div>
<script>
const token=${JSON.stringify(token)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(path,options={})=>{const r=await fetch(path,options);const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}if(!r.ok)throw new Error(typeof body==='string'?body:(body.error||JSON.stringify(body)));return body};
async function mutate(path,body){try{await api(path,{method:'POST',headers:{'x-mabs-token':token,'content-type':'application/json'},body:JSON.stringify(body||{})});document.querySelector('#notice').textContent='Saved';await load()}catch(e){alert(e.message)}}
const artifact=p=>'/api/artifact?path='+encodeURIComponent(p);
function feedbackRows(items){return items.map(f=>'<tr><td>'+esc(f.kind)+'</td><td>'+esc(f.body)+'</td><td>'+esc(f.state)+'</td><td>'+esc(f.response||'')+'</td><td><code>'+esc(f.linkedTaskId||'')+'</code></td></tr>').join('')}
async function addFeedback(type,id,version,projectId){const kind=prompt('Kind: comment, question, request_change, or priority','comment');if(!kind)return;const body=prompt(kind==='priority'?'New numeric priority':'Feedback');if(!body)return;await mutate('/api/feedback',{targetType:type,targetId:id,projectId,kind,body,expectedVersion:version})}
async function requestApproval(id){const action=prompt('Action requiring approval (for example: merge, push_branch, deploy)','merge');if(!action)return;const target=prompt('Exact target');if(!target)return;const reason=prompt('Reason and recovery notes');if(!reason)return;await mutate('/api/approvals',{taskId:id,action,target,reason})}
async function showTask(id){try{const d=await api('/api/tasks/'+encodeURIComponent(id));const t=d.task;const attempts=d.attempts.map(a=>'<tr><td>'+a.attemptNumber+' '+esc(a.kind)+'</td><td>'+esc(a.adapter)+'<br>'+esc(a.model||'default')+'</td><td>'+esc(a.state)+'</td><td>'+esc(a.failureClass||'')+' '+esc(a.reason||'')+'</td><td><code>'+esc(a.outputPath||'')+'</code></td><td>'+esc(JSON.stringify(a.usage||null))+'</td></tr>').join('');const gates=d.gates.map(g=>'<tr><td>'+esc(g.name)+'</td><td>'+esc(g.status)+'</td><td><code>'+esc(g.revision)+'</code></td><td>'+(g.evidencePath?'<a target="_blank" href="'+artifact(g.evidencePath)+'">evidence</a>':'')+'</td></tr>').join('');const reviews=d.reviews.map(r=>'<tr><td>'+esc(r.verdict)+'</td><td><code>'+esc(r.revision)+'</code></td><td>'+esc(r.summary)+'</td><td>'+r.findings.map(x=>'<div class="warn">'+esc(x)+'</div>').join('')+'</td></tr>').join('');const evidence=d.diagnostics.evidence.map(e=>'<li>'+(e.exists?'':'<span class="warn">missing </span>')+'<a target="_blank" href="'+artifact(e.path)+'">'+esc(e.label)+'</a> <code>'+esc(e.path)+'</code></li>').join('');document.querySelector('#app').innerHTML='<div class="card"><h2>'+esc(t.title)+'</h2><div><span class="pill">'+esc(t.state)+'</span><span class="pill">v'+t.recordVersion+'</span><span class="pill">'+esc(t.role)+'</span><span class="pill">'+esc(t.taskClass)+'</span></div><p>'+esc(t.objective)+'</p><b>Acceptance</b><ul>'+t.acceptanceCriteria.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p class="warn">'+esc(t.blockedReason||'')+'</p><button onclick="addFeedback(\'task\',\''+encodeURIComponent(t.id)+'\','+t.recordVersion+',\''+encodeURIComponent(t.projectId)+'\')">Feedback</button>'+(t.resultRevision?'<button class="secondary" onclick="requestApproval(\''+encodeURIComponent(t.id)+'\')">Prepare approval</button>':'')+''+(t.state==='BLOCKED'||t.state==='FAILED'?'<button onclick="mutate(\'/api/tasks/'+encodeURIComponent(t.id)+'/retry\',{version:'+t.recordVersion+'})">Retry</button>':'')+(['RUNNING','CHECKING','REVIEWING','READY','QUEUED'].includes(t.state)?'<button class="reject" onclick="mutate(\'/api/tasks/'+encodeURIComponent(t.id)+'/cancel\',{version:'+t.recordVersion+'})">Cancel</button>':'')+'</div><div class="grid"><div class="card"><h2>Latency</h2><pre>'+esc(JSON.stringify(d.latency,null,2))+'</pre></div><div class="card"><h2>Context health</h2>'+(d.diagnostics.warnings.length?d.diagnostics.warnings.map(x=>'<div class="warn">'+esc(x)+'</div>').join(''):'<div class="ok">No observable context warnings</div>')+'<pre>'+esc(JSON.stringify(d.diagnostics.requirementCoverage,null,2))+'</pre></div></div><div class="card"><h2>Attempts</h2><table><tr><th>#</th><th>Route</th><th>State</th><th>Reason</th><th>Output</th><th>Reported usage</th></tr>'+attempts+'</table></div><div class="card"><h2>Quality evidence</h2><table><tr><th>Gate</th><th>Status</th><th>Revision</th><th>Log</th></tr>'+gates+'</table><ul>'+evidence+'</ul></div><div class="card"><h2>Independent reviews</h2><table><tr><th>Verdict</th><th>Revision</th><th>Summary</th><th>Findings</th></tr>'+reviews+'</table></div><div class="card"><h2>Feedback</h2><table><tr><th>Kind</th><th>Message</th><th>State</th><th>Response</th><th>Follow-up</th></tr>'+feedbackRows(d.feedback)+'</table></div><div class="card"><h2>Timeline</h2><pre>'+esc(JSON.stringify(d.events,null,2))+'</pre></div>'}catch(e){alert(e.message)}}
async function showPlan(id){try{const d=await api('/api/plans/'+encodeURIComponent(id));const p=d.plan;const rows=d.items.map(i=>'<tr><td>'+esc(i.key)+'</td><td><a onclick="showTask(\''+encodeURIComponent(i.task.id)+'\')">'+esc(i.task.title)+'</a></td><td>'+esc(i.task.state)+'</td><td>'+i.dependencies.map(esc).join('<br>')+'</td><td>'+esc(i.task.executionReason||'')+'</td><td>'+esc(i.routing.at(-1)?.reason||'Not routed yet')+'</td></tr>').join('');document.querySelector('#app').innerHTML='<div class="card"><h2>'+esc(p.objective)+'</h2><div><span class="pill">'+esc(p.mode)+'</span><span class="pill">v'+p.version+'</span></div><p>'+esc(p.reason)+'</p><b>Assumptions</b><ul>'+p.assumptions.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><b>Milestones</b><ul>'+p.milestones.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><button onclick="addFeedback(\'plan\',\''+encodeURIComponent(p.id)+'\','+p.version+',\''+encodeURIComponent(p.projectId)+'\')">Comment or ask</button></div><div class="card"><h2>Dependency plan</h2><table><tr><th>Key</th><th>Task</th><th>State</th><th>Dependencies</th><th>Execution reason</th><th>Routing reason</th></tr>'+rows+'</table></div><div class="card"><h2>Feedback</h2><table><tr><th>Kind</th><th>Message</th><th>State</th><th>Response</th><th>Follow-up</th></tr>'+feedbackRows(d.feedback)+'</table></div>'}catch(e){alert(e.message)}}
async function decide(id,decision){const reason=prompt('Decision note (optional)','')||'';await mutate('/api/approvals/'+encodeURIComponent(id)+'/'+decision,{reason})}
async function answer(id){const response=prompt('Answer');if(response)await mutate('/api/feedback/'+encodeURIComponent(id)+'/answer',{response})}
async function load(){try{const d=await api('/api/overview');const counts=Object.entries(d.taskCounts).map(([k,v])=>'<div class="card"><b>'+esc(k)+'</b><div>'+v+'</div></div>').join('');const projects=d.projects.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+esc(p.status)+'</td><td>'+esc(p.goal||'')+'</td><td><code>'+esc(p.repoPath)+'</code></td><td>'+esc(p.reviewPolicy.mode)+'</td></tr>').join('');const workers=d.workers.map(w=>'<tr><td><code>'+esc(w.attemptId||w.id)+'</code></td><td>'+esc(w.adapter)+'</td><td>'+esc(w.pid||'')+'</td><td>'+esc(w.heartbeatAt||'')+'</td><td><code>'+esc(w.worktreePath||'')+'</code></td></tr>').join('');const plans=d.plans.map(p=>'<tr><td><a onclick="showPlan(\''+encodeURIComponent(p.id)+'\')">'+esc(p.objective)+'</a></td><td>'+esc(p.mode)+'</td><td>'+esc(p.state)+'</td><td>v'+p.version+'</td></tr>').join('');const tasks=d.tasks.map(t=>'<tr><td><a onclick="showTask(\''+encodeURIComponent(t.id)+'\')"><code>'+esc(t.id)+'</code></a></td><td>'+esc(t.title)+'</td><td>'+esc(t.state)+'</td><td>'+esc(t.blockedReason||'')+'</td></tr>').join('');const approvals=d.approvals.map(a=>'<tr><td>'+esc(a.action)+'</td><td>'+esc(a.reason||'')+'</td><td>'+esc(a.target)+'</td><td><code>'+esc(a.revision)+'</code></td><td><button onclick="decide(\''+encodeURIComponent(a.id)+'\',\'approve\')">Approve</button><button class="reject" onclick="decide(\''+encodeURIComponent(a.id)+'\',\'reject\')">Reject</button></td></tr>').join('');const questions=d.feedback.filter(f=>f.kind==='question'&&f.state==='pending').map(f=>'<tr><td>'+esc(f.body)+'</td><td>'+esc(f.taskId||f.planId)+'</td><td><button onclick="answer(\''+encodeURIComponent(f.id)+'\')">Answer</button></td></tr>').join('');document.querySelector('#app').innerHTML='<div class="grid">'+counts+'</div><div class="card"><h2>Projects</h2><table><tr><th>Name</th><th>Status</th><th>Goal</th><th>Repository</th><th>Review policy</th></tr>'+projects+'</table></div><div class="card"><h2>Active workers</h2><table><tr><th>Attempt</th><th>Provider</th><th>PID</th><th>Heartbeat</th><th>Worktree</th></tr>'+workers+'</table></div><div class="card"><h2>Plans</h2><table><tr><th>Objective</th><th>Mode</th><th>State</th><th>Version</th></tr>'+plans+'</table></div><div class="card"><h2>Tasks</h2><table><tr><th>ID</th><th>Task</th><th>State</th><th>Reason</th></tr>'+tasks+'</table></div><div class="card"><h2>Pending questions</h2><table><tr><th>Question</th><th>Target</th><th></th></tr>'+questions+'</table></div><div class="card"><h2>Pending approvals</h2><table><tr><th>Action</th><th>Reason</th><th>Target</th><th>Revision</th><th></th></tr>'+approvals+'</table></div><div class="grid"><div class="card"><h2>Providers</h2><pre>'+esc(JSON.stringify(d.providers,null,2))+'</pre></div><div class="card"><h2>Operations</h2><pre>'+esc(JSON.stringify(d.operations,null,2))+'</pre></div><div class="card"><h2>Controller</h2><pre>'+esc(JSON.stringify(d.health,null,2))+'</pre></div></div>'}catch(e){document.querySelector('#app').innerHTML='<div class="card warn">'+esc(e.message)+'</div>'}}
load();setInterval(()=>{if(!document.hidden)load()},10000);
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
          projects: records.listProjects(), tasks, taskCounts,
          workers: records.listRunningAttempts(),
          plans: records.listExecutionPlans(),
          approvals: records.listApprovals("pending"),
          feedback: records.listFeedback(),
          providers: records.listProviderCapacity(),
          operations: records.operationalMetrics(),
          health: records.latestHealth() ?? null,
        });
        return;
      }
      const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
      if (request.method === "GET" && planMatch) {
        const id = decodeURIComponent(planMatch[1] as string);
        const plan = records.getExecutionPlan(id);
        if (!plan) { json(response, 404, { error: "plan not found" }); return; }
        json(response, 200, { ...plan, feedback: records.listFeedback({ planId: id }) });
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
          routing: records.routingForTask(id),
          gates: records.gatesForTask(id),
          reviews: records.reviewsForTask(id),
          feedback: records.listFeedback({ taskId: id }),
          events: records.listEvents(id),
          latency: records.taskLatency(id),
          diagnostics: taskDiagnostics(records, id),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/artifact") {
        const path = url.searchParams.get("path");
        if (!path) { json(response, 400, { error: "artifact path is required" }); return; }
        json(response, 200, readArtifact(path));
        return;
      }
      if (request.method === "POST") {
        if (request.headers["x-mabs-token"] !== token) { json(response, 403, { error: "invalid mutation token" }); return; }
        const body = await requestBody(request);
        if (url.pathname === "/api/approvals") {
          const task = typeof body.taskId === "string" ? records.getTask(decodeURIComponent(body.taskId)) : null;
          const project = task ? records.getProject(task.projectId) : null;
          const action = body.action as Action;
          if (!task || !project || !task.resultRevision || !ACTIONS.includes(action)) throw new Error("A completed task, valid action, and checked revision are required");
          const target = typeof body.target === "string" ? body.target : "";
          const reason = typeof body.reason === "string" ? body.reason : "";
          if (!target || !reason) throw new Error("Approval target and reason are required");
          json(response, 200, records.prepareApproval({ taskId: task.id, action, target, reason }));
          return;
        }
        const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
        if (approvalMatch) {
          const approval = records.decideApproval(
            decodeURIComponent(approvalMatch[1] as string),
            approvalMatch[2] === "approve" ? "approved" : "rejected",
            "local-workbench",
            typeof body.reason === "string" ? body.reason : undefined,
          );
          json(response, 200, approval);
          return;
        }
        const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
        if (cancelMatch && options.controller) {
          const version = Number(body.version);
          if (!Number.isSafeInteger(version) || version < 1) { json(response, 400, { error: "record version is required" }); return; }
          await options.controller.cancelTask(decodeURIComponent(cancelMatch[1] as string), version);
          json(response, 200, { ok: true });
          return;
        }
        const retryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry$/);
        if (retryMatch) {
          const version = Number(body.version);
          if (!Number.isSafeInteger(version) || version < 1) { json(response, 400, { error: "record version is required" }); return; }
          json(response, 200, records.retryTask(decodeURIComponent(retryMatch[1] as string), version));
          return;
        }
        if (url.pathname === "/api/feedback") {
          const targetType = body.targetType;
          const targetId = typeof body.targetId === "string" ? decodeURIComponent(body.targetId) : null;
          const projectId = typeof body.projectId === "string" ? decodeURIComponent(body.projectId) : null;
          if (!targetId || !projectId || (targetType !== "task" && targetType !== "plan")) throw new Error("Feedback target is required");
          json(response, 200, records.submitFeedback({
            projectId,
            taskId: targetType === "task" ? targetId : null,
            planId: targetType === "plan" ? targetId : null,
            kind: body.kind as Feedback["kind"],
            body: typeof body.body === "string" ? body.body : "",
            expectedVersion: Number(body.expectedVersion),
            createdBy: "local-workbench",
          }));
          return;
        }
        const answerMatch = url.pathname.match(/^\/api\/feedback\/([^/]+)\/answer$/);
        if (answerMatch) {
          json(response, 200, records.answerFeedback(
            decodeURIComponent(answerMatch[1] as string),
            typeof body.response === "string" ? body.response : "",
            "local-workbench",
          ));
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
    listen: () => new Promise<{ host: string; port: number }>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4317, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolvePromise({ host, port: typeof address === "object" && address ? address.port : (options.port ?? 4317) });
      });
    }),
  };
}
