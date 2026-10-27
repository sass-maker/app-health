export declare const AGENT_SURFACE: {
  name: string;
  url: string;
  llmsTxt: string;
  llmsFullTxt?: string;
  indexMd: string;
  catalog: Record<string, unknown>;
};
export declare function handleAgentEdge(request: Request): Promise<Response | null>;
