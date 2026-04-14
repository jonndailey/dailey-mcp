import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiRequest, formatError, textResult } from '../api.js';

interface StorageInfoResponse {
  project: {
    id: string;
    name: string;
    slug: string;
  };
  binding: {
    bucket: string;
    provider: string;
    endpoint: string;
    region: string;
    cdn_base_url: string;
    binding_model: string;
    upload_strategy: string;
    download_strategy: string;
    usage: {
      total_objects: number;
      total_size_mb: number;
      storage_limit_mb: number;
    };
    limits: {
      max_single_upload_mb: number;
      signed_url_ttl_seconds: number;
    };
  };
  next_step?: string;
}

interface StorageListResponse {
  bucket: string;
  prefix: string;
  continuation_token: string | null;
  objects: Array<{
    key: string;
    size_bytes: number;
    size_mb: number;
    last_modified: string | null;
    etag: string | null;
  }>;
}

interface PresignedUploadResponse {
  bucket: string;
  key: string;
  method: string;
  upload_url: string;
  expires_at: string;
  headers: Record<string, string>;
}

interface PresignedDownloadResponse {
  bucket: string;
  key: string;
  download_url: string;
  expires_at: string;
  content_type: string | null;
  size_bytes: number | null;
}

export function registerStorageTools(server: McpServer) {
  server.tool(
    'dailey_storage_info',
    'Show the project-scoped storage binding, usage, and presign model',
    { project_id: z.string().describe('The project ID') },
    async ({ project_id }) => {
      const res = await apiRequest<StorageInfoResponse>('GET', `/projects/${project_id}/storage`);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Storage: ${data.project.name}`,
        `Slug:        ${data.project.slug}`,
        `Bucket:      ${data.binding.bucket}`,
        `Provider:    ${data.binding.provider}`,
        `Endpoint:    ${data.binding.endpoint}`,
        `Region:      ${data.binding.region}`,
        `CDN Base:    ${data.binding.cdn_base_url}`,
        `Mode:        ${data.binding.binding_model}`,
        `Upload:      ${data.binding.upload_strategy}`,
        `Download:    ${data.binding.download_strategy}`,
        `Objects:     ${data.binding.usage.total_objects}`,
        `Usage:       ${data.binding.usage.total_size_mb} MB / ${data.binding.usage.storage_limit_mb} MB`,
        `Max Upload:  ${data.binding.limits.max_single_upload_mb} MB`,
        `URL TTL:     ${data.binding.limits.signed_url_ttl_seconds}s`,
      ];

      if (data.next_step) {
        lines.push('');
        lines.push(`Next Step: ${data.next_step}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_storage_list_objects',
    'List objects in a project bucket',
    {
      project_id: z.string().describe('The project ID'),
      prefix: z.string().optional().describe('Optional object key prefix'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum objects to return'),
      continuation_token: z.string().optional().describe('Token for the next page of objects'),
    },
    async ({ project_id, prefix, limit, continuation_token }) => {
      const params = new URLSearchParams();
      if (prefix) params.set('prefix', prefix);
      if (typeof limit === 'number') params.set('limit', String(limit));
      if (continuation_token) params.set('continuation_token', continuation_token);
      const query = params.toString();

      const res = await apiRequest<StorageListResponse>(
        'GET',
        `/projects/${project_id}/storage/objects${query ? `?${query}` : ''}`,
      );
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Bucket: ${data.bucket}`,
        `Prefix: ${data.prefix || '(root)'}`,
        '',
      ];

      if ((data.objects || []).length === 0) {
        lines.push('No objects found.');
      } else {
        for (const object of data.objects) {
          lines.push(`- ${object.key}`);
          lines.push(`  size_mb: ${object.size_mb}`);
          lines.push(`  size_bytes: ${object.size_bytes}`);
          lines.push(`  last_modified: ${object.last_modified || '-'}`);
        }
      }

      if (data.continuation_token) {
        lines.push('');
        lines.push(`continuation_token: ${data.continuation_token}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_storage_presign_upload',
    'Create a presigned upload URL for an object in a project bucket',
    {
      project_id: z.string().describe('The project ID'),
      key: z.string().describe('The object key to upload'),
      content_type: z.string().optional().describe('Optional content type to bind into the signed request'),
      content_length_bytes: z.number().int().positive().optional().describe('Optional content length for plan-limit checks'),
      expires_in_seconds: z.number().int().min(60).max(3600).optional().describe('Optional URL TTL'),
    },
    async ({ project_id, key, content_type, content_length_bytes, expires_in_seconds }) => {
      const body: Record<string, unknown> = { key };
      if (content_type) body.content_type = content_type;
      if (typeof content_length_bytes === 'number') body.content_length_bytes = content_length_bytes;
      if (typeof expires_in_seconds === 'number') body.expires_in_seconds = expires_in_seconds;

      const res = await apiRequest<PresignedUploadResponse>('POST', `/projects/${project_id}/storage/presign-upload`, body);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Presigned Upload`,
        `Bucket:  ${data.bucket}`,
        `Key:     ${data.key}`,
        `Method:  ${data.method}`,
        `Expires: ${data.expires_at}`,
      ];
      for (const [header, value] of Object.entries(data.headers || {})) {
        lines.push(`${header}: ${value}`);
      }
      lines.push('');
      lines.push(data.upload_url);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'dailey_storage_presign_download',
    'Create a presigned download URL for an object in a project bucket',
    {
      project_id: z.string().describe('The project ID'),
      key: z.string().describe('The object key to download'),
      download_name: z.string().optional().describe('Optional filename suggestion for the download'),
      expires_in_seconds: z.number().int().min(60).max(3600).optional().describe('Optional URL TTL'),
    },
    async ({ project_id, key, download_name, expires_in_seconds }) => {
      const body: Record<string, unknown> = { key };
      if (download_name) body.download_name = download_name;
      if (typeof expires_in_seconds === 'number') body.expires_in_seconds = expires_in_seconds;

      const res = await apiRequest<PresignedDownloadResponse>('POST', `/projects/${project_id}/storage/presign-download`, body);
      if (!res.ok) return textResult(formatError(res));

      const data = res.data;
      const lines = [
        `Presigned Download`,
        `Bucket:  ${data.bucket}`,
        `Key:     ${data.key}`,
        `Expires: ${data.expires_at}`,
      ];
      if (data.content_type) lines.push(`Type:    ${data.content_type}`);
      if (data.size_bytes !== null) lines.push(`Size:    ${data.size_bytes} bytes`);
      lines.push('');
      lines.push(data.download_url);
      return textResult(lines.join('\n'));
    },
  );
}
