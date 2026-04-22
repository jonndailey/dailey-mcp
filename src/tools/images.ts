import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

export function registerImageTools(server: McpServer) {
  // Deploy a Docker image
  server.tool(
    'dailey_run_image',
    'Deploy a Docker image to Dailey OS. Creates a project and deploys the image in one step. Examples: wordpress:6-apache, ghost:5-alpine, nginx:alpine, grafana/grafana:latest',
    {
      image: z.string().describe('Docker image to deploy (e.g., wordpress:6-apache, nginx:alpine)'),
      name: z.string().optional().describe('Project name (auto-generated if not provided)'),
      database: z
        .union([z.enum(['mysql', 'postgres']), z.boolean()])
        .optional()
        .describe('Provision a managed database: "mysql" | "postgres" | true (= mysql, for back-compat) | false. Default: no database.'),
    },
    async ({ image, name, database }) => {
      const projectName = name || image.split('/').pop()?.split(':')[0] || 'app';

      // Normalize the database flag.
      //   false / undefined → no DB
      //   true              → mysql (back-compat with pre-0.9 callers)
      //   "mysql" | "postgres" → that engine
      let needsDatabase = false;
      let databaseType: 'mysql' | 'postgres' | undefined;
      if (database === true) {
        needsDatabase = true;
        databaseType = 'mysql';
      } else if (database === 'mysql' || database === 'postgres') {
        needsDatabase = true;
        databaseType = database;
      }

      // Gentle nudge if the user asked for a DB alongside an image that
      // IS the database — that's usually a mistake.
      let noteIfRedundant = '';
      const imgLower = image.toLowerCase();
      if (needsDatabase && databaseType === 'postgres' && /(^|\/)postgres:/.test(imgLower)) {
        noteIfRedundant = '\nNote: you asked for a managed Postgres alongside a postgres image. ' +
          'The image IS a database — you probably want database: false and to connect to this project directly.\n';
      }
      if (needsDatabase && databaseType === 'mysql' && /(^|\/)mysql:|mariadb:/.test(imgLower)) {
        noteIfRedundant = '\nNote: you asked for a managed MySQL alongside a MySQL/MariaDB image. ' +
          'The image IS a database — you probably want database: false and to connect to this project directly.\n';
      }

      // Create project
      const createRes = await apiRequest<any>('POST', '/projects', {
        name: projectName,
        repo_url: image,
        branch: 'main',
        needs_database: needsDatabase,
        database_type: databaseType,
      });

      if (!createRes.ok) return textResult(formatError(createRes));

      const project = createRes.data;

      // Trigger deploy
      const deployRes = await apiRequest<any>('POST', `/projects/${project.id}/deploy`);

      let result = `Deployed ${image} → https://${project.slug}.dailey.cloud\n\n`;
      result += `Project: ${project.name}\n`;
      result += `Slug: ${project.slug}\n`;
      result += `URL: https://${project.slug}.dailey.cloud\n`;

      if (project.slug_auto_generated) {
        result += `Note: ${project.slug_note}\n`;
      }

      if (project.database) {
        result += `Database: ${project.database.database} (${project.database.type || 'mysql'})\n`;
      }
      if (noteIfRedundant) result += noteIfRedundant;

      if (deployRes.ok && deployRes.data?.credentials) {
        result += `\nCredentials:\n`;
        for (const [key, val] of Object.entries(deployRes.data.credentials)) {
          if (key !== 'note' && key !== 'label') {
            result += `  ${key}: ${val}\n`;
          }
        }
      }

      result += `\nBuild ID: ${deployRes.data?.build_id || 'pending'}\n`;
      result += `\nNext: call dailey_deploy_status with project_id=${project.id} to watch progress.\n`;
      result += `      If it fails, call dailey_build_logs with project_id=${project.id} for full output.`;

      return textResult(result);
    },
  );

  // Analyze a Docker image
  server.tool(
    'dailey_inspect_image',
    'Analyze a Docker image before deploying. Shows size, port, database needs, and compatibility.',
    {
      image: z.string().describe('Docker image to analyze (e.g., wordpress:6-apache)'),
    },
    async ({ image }) => {
      const res = await apiRequest<any>('POST', '/deploy/analyze', { repo_url: image });
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;

      if (!data._isDockerImage) {
        return textResult(`"${image}" was detected as a Git repository, not a Docker image.`);
      }

      let result = `Image Analysis: ${image}\n\n`;
      result += `Registry: ${data.image?.registry || 'Docker Hub'}\n`;
      result += `Size: ${data.image?.size_mb || '?'} MB\n`;
      result += `Port: ${data.image?.port || 3000}\n`;
      result += `Database needed: ${data.database?.needed ? 'Yes' : 'No'}\n`;

      if (data.image?.catalog_match) {
        result += `Catalog: ✓ ${data.image.catalog_match} (pre-configured)\n`;
      }
      if (data.image?.description) {
        result += `Description: ${data.image.description}\n`;
      }
      if (data.estimates) {
        result += `\nEstimated pull time: ~${data.estimates.pull_time_seconds}s\n`;
        result += `Estimated deploy time: ~${data.estimates.deploy_time_seconds}s\n`;
      }

      if (data.issues?.length) {
        result += `\nBlocking issues:\n`;
        for (const issue of data.issues) {
          result += `  ✗ ${issue}\n`;
        }
      } else {
        result += `\n✓ Ready to deploy: use dailey_run_image with image="${image}"`;
      }

      return textResult(result);
    },
  );

  // List marketplace catalog
  server.tool(
    'dailey_marketplace_catalog',
    'List all available pre-configured marketplace apps that can be deployed with one command.',
    {},
    async () => {
      // Note: the customer-api proxies /projects/catalog → deploy-service /deploys/catalog.
      // The old path /deploy/catalog never existed on customer-api and always 404'd.
      const res = await apiRequest<{ apps: any[] }>('GET', '/projects/catalog');
      if (!res.ok) return textResult(formatError(res));

      let result = 'Marketplace Catalog\n\n';
      for (const app of res.data.apps) {
        result += `${app.name} (${app.image})\n`;
        result += `  ${app.description}\n`;
        result += `  Database: ${app.needs_database ? 'Yes' : 'No'} | Memory: ${app.memory_mb}MB\n\n`;
      }
      result += `Deploy any of these with: dailey_run_image image="<image>"`;

      return textResult(result);
    },
  );

  // Get project credentials
  server.tool(
    'dailey_project_credentials',
    'Get auto-generated credentials (passwords) for a project. Useful for logging into deployed apps like code-server, Grafana, WordPress.',
    {
      project_id: z.string().describe('The project ID'),
    },
    async ({ project_id }) => {
      const res = await apiRequest<{ credentials: any[] }>('GET', `/projects/${project_id}/credentials`);
      if (!res.ok) return textResult(formatError(res));

      if (!res.data.credentials?.length) {
        return textResult('No auto-generated credentials for this project.');
      }

      let result = 'Project Credentials\n\n';
      for (const cred of res.data.credentials) {
        result += `${cred.label}: ${cred.value}\n`;
      }

      return textResult(result);
    },
  );

  // Get project resources
  server.tool(
    'dailey_project_resources',
    'Get resource usage for a project — CPU, memory, storage, pod status.',
    {
      project_id: z.string().describe('The project ID'),
    },
    async ({ project_id }) => {
      const res = await apiRequest<any>('GET', `/projects/${project_id}/resources`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      let result = `Resources for ${data.project}\n\n`;
      result += `Replicas: ${data.replicas}\n`;
      result += `CPU limit: ${data.resources?.cpu_limit}\n`;
      result += `Memory limit: ${data.resources?.memory_limit_mb} MB\n`;
      result += `Storage: ${data.resources?.storage?.capacity || 'None (ephemeral)'}\n`;

      if (data.storage_warning) {
        result += `\n⚠ ${data.storage_warning}\n`;
      }

      if (data.pods?.length) {
        result += `\nPods:\n`;
        for (const pod of data.pods) {
          result += `  ${pod.name} — ${pod.status} — ${pod.restarts} restarts — node: ${pod.node}\n`;
        }
      }

      return textResult(result);
    },
  );
}
