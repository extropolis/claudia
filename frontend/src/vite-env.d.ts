/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * Overrides the backend port the web build talks to. Lets a sandboxed
     * instance (E2E harness, second checkout) avoid the developer's live
     * backend on 4001. See src/config/api-config.ts.
     */
    readonly VITE_CLAUDIA_BACKEND_PORT?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
