import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface Project {
  id: string;
  name: string;
  status?: string;
  repo_url?: string;
  branch?: string;
  replicas?: number;
  created_at?: string;
  url?: string;
  needs_database?: boolean;
}

export function registerProjectTools(server: McpServer) {
  server.tool(
    'dailey_list_projects',
    'List all projects with status',
    {},
    async () => {
      const res = await apiRequest<{ projects: Project[] }>('GET', '/projects');
      if (!res.ok) return textResult(formatError(res));

      const projects = res.data.projects;
      if (!projects || projects.length === 0) {
        return textResult('No projects found.');
      }

      const lines = [
        `Projects (${projects.length})`,
        `${'ID'.padEnd(38)} ${'Name'.padEnd(24)} ${'Status'.padEnd(12)} Replicas`,
        '─'.repeat(90),
      ];

      for (const p of projects) {
        lines.push(
          `${(p.id || '').padEnd(38)} ${(p.name || '').padEnd(24)} ${(p.status || 'unknown').padEnd(12)} ${p.replicas ?? '-'}`,
        );
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_project_info',
    'Get detailed info about a project including linked services',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<any>('GET', `/projects/${project_id}`);
      if (!res.ok) return textResult(formatError(res));

      const p = res.data;
      const lines = [
        `Project: ${p.name}`,
        `─────────────────────────────`,
        `ID:         ${p.id}`,
        `Status:     ${p.status || 'unknown'}`,
        `Repo:       ${p.repo_url || 'none'}`,
        `Branch:     ${p.branch || 'main'}`,
        `Replicas:   ${p.replicas ?? '-'}`,
        `Database:   ${p.needs_database ? 'yes' : 'no'}`,
        `URL:        ${p.url || 'none'}`,
        `Created:    ${p.created_at || 'unknown'}`,
      ];

      const services = p.services;
      if (services?.length > 0) {
        lines.push('');
        lines.push(`Services (${services.length + 1}):`);
        lines.push(`  ● ${p.slug} [primary] ${p.status}`);
        for (const svc of services) {
          lines.push(`  ● ${svc.slug || svc.name} [${svc.service_role || 'secondary'}] ${svc.status}`);
        }
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_project_services',
    'List all services in a multi-container project',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<any>('GET', `/projects/${project_id}`);
      if (!res.ok) return textResult(formatError(res));

      const p = res.data;
      const services = p.services || [];

      if (services.length === 0) {
        return textResult(`${p.name} is a single-container project with no linked services.`);
      }

      const lines = [
        `Services for ${p.name} (${services.length + 1} total)`,
        '─'.repeat(60),
        `● ${(p.slug || '').padEnd(30)} primary     ${p.status}`,
      ];

      for (const svc of services) {
        lines.push(`● ${(svc.slug || svc.name || '').padEnd(30)} ${(svc.service_role || 'secondary').padEnd(12)} ${svc.status}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_deploy_multi',
    'Trigger a multi-container deploy for a project with multiple services',
    {
      project_id: z.string().describe('The project ID'),
      selected_services: z.array(z.object({
        name: z.string(),
        type: z.enum(['managed', 'app_service']),
        provider: z.string().optional(),
        dockerfile: z.string().optional(),
        buildContext: z.string().optional(),
      })).optional().describe('Services to deploy (if omitted, deploys all detected services)'),
    },
    async ({ project_id, selected_services }) => {
      // If no services provided, analyze first to discover them
      let services = selected_services;
      if (!services) {
        const projRes = await apiRequest<any>('GET', `/projects/${project_id}`);
        if (!projRes.ok) return textResult(formatError(projRes));

        const analyzeRes = await apiRequest<any>('POST', '/projects/analyze', {
          repo_url: projRes.data.repo_url,
          branch: projRes.data.branch,
        });
        if (!analyzeRes.ok) return textResult(formatError(analyzeRes));

        const manifest = analyzeRes.data.services_manifest;
        if (!manifest?.entries?.length) {
          return textResult('No multi-service manifest found. Use dailey_deploy instead for single-container projects.');
        }
        services = manifest.entries.filter((e: any) => e.type === 'managed' || e.type === 'app_service');
      }

      // Safety: ensure at least one service is marked 'app_service' so the
      // deployer knows which one gets the public ingress. Without this, all
      // services deploy as "internal only" and the project is unreachable
      // with no warning. (Scott hit this on 2026-04-20.)
      const hasAppService = services?.some((s: any) => s.type === 'app_service');
      if (services?.length && !hasAppService) {
        services[0].type = 'app_service';
      }

      const res = await apiRequest<any>('POST', `/projects/${project_id}/deploy-multi`, {
        selected_services: services,
      });
      if (!res.ok) return textResult(formatError(res));

      const primary = services?.find((s: any) => s.type === 'app_service')?.name;
      return textResult([
        `Multi-container deploy triggered!`,
        ``,
        `Build ID:       ${res.data.build_id}`,
        `Deploy Group:   ${res.data.deploy_group_id}`,
        `Services:       ${services?.length || 0}`,
        `Primary (web):  ${primary || 'none — check deploy log'}`,
        ``,
        `Next: call dailey_deploy_status with project_id=${project_id} to watch progress.`,
        `      If it fails, call dailey_build_logs with project_id=${project_id} for full output.`,
      ].join('\n'));
    },
  );

  server.tool(
    'dailey_create_project',
    'Create a new project',
    {
      name: z.string().describe('Project name'),
      repo_url: z.string().describe('Git repository URL'),
      branch: z.string().optional().describe('Branch to deploy (default: main)'),
      needs_database: z.boolean().optional().describe('Whether the project needs a database'),
    },
    async ({ name, repo_url, branch, needs_database }) => {
      const body: Record<string, unknown> = { name, repo_url };
      if (branch) body.branch = branch;
      if (needs_database !== undefined) body.needs_database = needs_database;

      const res = await apiRequest<Project>('POST', '/projects', body);
      if (!res.ok) return textResult(formatError(res));

      const p = res.data;
      return textResult(
        [
          `Project created successfully!`,
          ``,
          `ID:       ${p.id}`,
          `Name:     ${p.name}`,
          `Status:   ${p.status || 'pending'}`,
          `Repo:     ${p.repo_url}`,
          `Branch:   ${p.branch || 'main'}`,
          `Database: ${p.needs_database ? 'yes' : 'no'}`,
        ].join('\n'),
      );
    },
  );

  server.tool(
    'dailey_delete_project',
    'Delete a project (irreversible)',
    { project_id: z.string().describe('The project ID to delete') },
    async ({ project_id }) => {
      const res = await apiRequest('DELETE', `/projects/${project_id}`);
      if (!res.ok) return textResult(formatError(res));
      return textResult(`Project ${project_id} deleted successfully.`);
    },
  );
}
