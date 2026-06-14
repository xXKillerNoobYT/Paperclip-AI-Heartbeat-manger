import { request } from 'node:http';
import { request as secureRequest } from 'node:https';

const ACTIONABLE_STATUSES = new Set(['todo', 'backlog', 'in_progress']);

export class PaperclipClient {
  constructor({ baseUrl, dryRun = true, fetchImpl = null }) {
    if (!baseUrl) throw new Error('PaperclipClient requires baseUrl');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.dryRun = dryRun;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  async listAssignedActionableIssues(companyId, agentId) {
    const issues = await this.getJson(`/companies/${companyId}/issues?assigneeAgentId=${agentId}`);
    return issues.filter((issue) => ACTIONABLE_STATUSES.has(issue.status));
  }

  async wakeAgent(agentId, body = {}) {
    if (this.dryRun) {
      return { dryRun: true, invoked: false, agentId, body };
    }
    return this.postJson(`/agents/${agentId}/heartbeat/invoke`, body);
  }

  async getJson(path) {
    return this.requestJson('GET', path);
  }

  async postJson(path, body) {
    return this.requestJson('POST', path, body);
  }

  async requestJson(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    if (this.fetchImpl) {
      const response = await this.fetchImpl(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(`Paperclip ${method} ${path} failed: ${response.status}`);
      return response.json();
    }
    return requestJsonWithoutFetch(method, url, body);
  }
}

function requestJsonWithoutFetch(method, urlString, body) {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? secureRequest : request;
  return new Promise((resolve, reject) => {
    const req = transport(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Paperclip ${method} ${url.pathname} failed: ${res.statusCode}`));
          return;
        }
        resolve(data ? JSON.parse(data) : null);
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
