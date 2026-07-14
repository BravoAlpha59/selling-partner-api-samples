// src/services.ts
//
// Process-wide shared services for the dev-assistant MCP server.
//
// The expensive resources — the parsed API catalog, the ONNX embedding model,
// and the search index — are created ONCE here and shared across every
// connection. In the HTTP transport we open one McpServer per session (each
// bound to its own account code); those per-session servers all delegate to a
// single SharedServices instance so we never load the model or catalog twice.

import { join } from "path";
import { SPAPIMigrationAssistantTool } from "./tools/migration-assistant-tools/migration-tools.js";
import { CodeGenerationTool } from "./tools/code-generation-tools/code-generation-tool.js";
import { OptimizationTool } from "./tools/optimization-tools/optimization-tool.js";
import { createSearchTool } from "./tools/search-tools/setup.js";
import type { SearchToolSetup } from "./tools/search-tools/setup.js";
import { CatalogLoader } from "./catalog/catalog-loader.js";
import { ExecuteApiTool } from "./tools/execute-api-tool.js";
import { ExploreCatalogTool } from "./tools/explore-catalog-tool.js";
import { resolveAuthenticator } from "./auth/account-credentials.js";
import type { ApiCatalog } from "./types/api-catalog.js";

export class SharedServices {
  readonly migrationAssistantTool: SPAPIMigrationAssistantTool;
  readonly codeGenerationTool: CodeGenerationTool;
  readonly optimizationTool: OptimizationTool;
  readonly search: SearchToolSetup;

  private readonly catalogLoader = new CatalogLoader();
  private catalogPromise: Promise<ApiCatalog> | null = null;
  private exploreTool: ExploreCatalogTool | null = null;
  // Keyed by resolved account code, so sessions sharing an account also share
  // its access-token cache.
  private readonly executeToolsByAccount = new Map<string, ExecuteApiTool>();

  constructor(public readonly dataRoot: string) {
    this.migrationAssistantTool = new SPAPIMigrationAssistantTool(
      join(dataRoot, "resources", "orders-api-migration-data.json"),
    );
    this.codeGenerationTool = new CodeGenerationTool();
    this.optimizationTool = new OptimizationTool();
    this.search = createSearchTool(dataRoot);
  }

  ensureCatalogLoaded(): Promise<ApiCatalog> {
    if (!this.catalogPromise) {
      this.catalogPromise = this.catalogLoader.loadCatalog();
    }
    return this.catalogPromise;
  }

  async getExploreTool(): Promise<ExploreCatalogTool> {
    if (!this.exploreTool) {
      const catalog = await this.ensureCatalogLoaded();
      this.exploreTool = new ExploreCatalogTool(catalog);
    }
    return this.exploreTool;
  }

  async getExecuteTool(accountCode?: string): Promise<ExecuteApiTool> {
    // Resolve the account (and its hidden credentials) before touching the
    // catalog so a misconfigured/unknown code fails fast with a clear message.
    const { accountCode: resolvedCode, authenticator } =
      resolveAuthenticator(accountCode);

    let tool = this.executeToolsByAccount.get(resolvedCode);
    if (!tool) {
      const catalog = await this.ensureCatalogLoaded();
      tool = new ExecuteApiTool(catalog, authenticator);
      this.executeToolsByAccount.set(resolvedCode, tool);
    }
    return tool;
  }

  /** Warm the embedding model and search index in the background (non-blocking). */
  preload(): void {
    this.search.embeddingService.preload().catch(() => {});
    this.search.indexManager.initialize().catch(() => {});
  }
}
