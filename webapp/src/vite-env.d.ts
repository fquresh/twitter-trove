/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_API_PROXY?: string;
  readonly VITE_DATA_BASE_URL?: string;
  /** Deployed cloud origin, shown in Settings → MCP server by local builds. */
  readonly VITE_CLOUD_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
